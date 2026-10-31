import json
from neo4j import AsyncGraphDatabase
from .models import Envelope
from .path_analysis import analyze_paths
from .workload_resolution import resolve_workload_endpoints

RELATIONSHIPS = {
    "HAS_SERVICE", "HAS_LISTENER", "HAS_FIREWALL", "HAS_PRIVILEGE", "HAS_CONFIGURATION",
    "HAS_IDENTITY", "HAS_PROCESS", "OBSERVED_CONNECTION", "INFERRED_REACHABILITY",
    "CONFIRMED_ATTACK_TRANSITION",
}

# Tenant isolation in a shared Community-edition database: every node carries
# `tenant` and a unique `key` = "<tenant>|<id>". Nodes are only ever MERGEd or
# MATCHed by key, so a shared endpoint (for example the same remote IP seen by
# two customers) becomes two independent nodes and no edge can cross tenants.
SCHEMA = (
    "DROP CONSTRAINT asset_id IF EXISTS",
    "DROP CONSTRAINT archetype_hash IF EXISTS",
    "CREATE CONSTRAINT asset_key IF NOT EXISTS FOR (n:Asset) REQUIRE n.key IS UNIQUE",
    "CREATE CONSTRAINT archetype_key IF NOT EXISTS FOR (n:Archetype) REQUIRE n.key IS UNIQUE",
    "CREATE INDEX asset_tenant IF NOT EXISTS FOR (n:Asset) ON (n.tenant)",
    "CREATE INDEX archetype_tenant IF NOT EXISTS FOR (n:Archetype) ON (n.tenant)",
    "CREATE INDEX component_kind IF NOT EXISTS FOR (n:Component) ON (n.kind)",
    "CREATE INDEX host_last_seen IF NOT EXISTS FOR (n:Host) ON (n.last_seen)",
)
MIGRATION = (
    "MATCH (n:Asset) WHERE n.key IS NULL SET n.key = coalesce(n.tenant, 'default') + '|' + n.id, n.tenant = coalesce(n.tenant, 'default')",
    "MATCH (n:Archetype) WHERE n.key IS NULL SET n.key = coalesce(n.tenant, 'default') + '|' + n.hash, n.tenant = coalesce(n.tenant, 'default')",
)


def scoped(tenant: str, identifier: str) -> str:
    return f"{tenant}|{identifier}"


class GraphStore:
    def __init__(self, uri: str, user: str, password: str):
        self.driver = AsyncGraphDatabase.driver(uri, auth=(user, password))

    async def open(self):
        async with self.driver.session() as session:
            # Backfill keys before the uniqueness constraints are created.
            for statement in SCHEMA[:2] + MIGRATION + SCHEMA[2:]:
                await (await session.run(statement)).consume()

    async def close(self):
        await self.driver.close()

    async def apply(self, tenant: str, envelope: Envelope):
        async with self.driver.session() as session:
            await session.execute_write(self._apply_tx, tenant, envelope)

    @staticmethod
    async def _apply_tx(tx, tenant: str, e: Envelope):
        h = e.host
        host_key = scoped(tenant, h.id)
        await tx.run(
            """MERGE (n:Asset:Host {key:$key}) SET n.id=$id,n.tenant=$tenant,n.hostname=$hostname,n.os=$os,
               n.os_version=$os_version,n.architecture=$architecture,n.kernel=$kernel,n.hardware_json=$hardware,
               n.last_seen=datetime($seen),n.agent_id=$agent_id""",
            key=host_key, id=h.id, tenant=tenant, hostname=h.hostname, os=h.os, os_version=h.os_version,
            architecture=h.architecture, kernel=h.kernel, hardware=json.dumps(h.hardware, sort_keys=True),
            seen=e.sent_at.isoformat(), agent_id=e.agent_id,
        )
        active_ids = [c.id for c in e.components]
        if e.full_snapshot:
            result = await tx.run(
                """MATCH (h:Host {key:$host})-[r]->(c:Component {tenant:$tenant})
                   WHERE NOT c.id IN $active DETACH DELETE c""", host=host_key, tenant=tenant, active=active_ids,
            )
            await result.consume()
        elif e.removed:
            result = await tx.run("MATCH (c:Component) WHERE c.key IN $removed DETACH DELETE c",
                                  removed=[scoped(tenant, item) for item in e.removed])
            await result.consume()

        for c in e.components:
            key = scoped(tenant, c.id)
            await tx.run(
                """MERGE (c:Asset:Component {key:$key}) SET c.id=$id,c.tenant=$tenant,c.kind=$kind,c.hash=$hash,
                   c.data_json=$data,c.observed_at=datetime($observed),c.evidence_source=$source,
                   c.confidence=$confidence,c.last_seen=datetime($seen)""",
                key=key, id=c.id, tenant=tenant, kind=c.kind, hash=c.hash, data=json.dumps(c.data, sort_keys=True),
                observed=c.evidence.observed_at.isoformat(), source=c.evidence.source,
                confidence=c.evidence.confidence, seen=e.sent_at.isoformat(),
            )
            await tx.run(
                """MATCH (c:Component {key:$key})-[r:INSTANCE_OF]->(a:Archetype)
                   WHERE a.hash <> $hash DELETE r""", key=key, hash=c.archetype_hash,
            )
            if c.archetype_hash:
                # Archetypes are per tenant: grouping never reveals that another
                # customer runs an identical configuration.
                await tx.run(
                    """MERGE (a:Archetype {key:$akey}) SET a.hash=$hash,a.tenant=$tenant,a.kind=$kind
                       WITH a MATCH (c:Component {key:$key}) MERGE (c)-[:INSTANCE_OF]->(a)""",
                    akey=scoped(tenant, c.archetype_hash), hash=c.archetype_hash, tenant=tenant, kind=c.kind, key=key,
                )

        # The agent sends the complete current relationship set on every envelope,
        # including deltas. Replace its host-scoped structural and live edges.
        await tx.run(
            """MATCH (h:Host {key:$host})-[r]->()
               WHERE type(r) STARTS WITH 'HAS_'
                  OR type(r) IN ['OBSERVED_CONNECTION', 'INFERRED_REACHABILITY']
               DELETE r""", host=host_key,
        )
        for r in e.relationships:
            if r.kind not in RELATIONSHIPS:
                raise ValueError(f"unsupported relationship {r.kind}")
            for identifier in (r.source_id, r.target_id):
                await tx.run("MERGE (n:Asset {key:$key}) ON CREATE SET n.id=$id,n.tenant=$tenant",
                             key=scoped(tenant, identifier), id=identifier, tenant=tenant)
            query = f"""MATCH (s:Asset {{key:$source}}),(t:Asset {{key:$target}})
                         MERGE (s)-[r:{r.kind}]->(t)
                         SET r.properties_json=$properties,r.evidence_source=$evidence_source,
                             r.observed_at=datetime($observed),r.confidence=$confidence,r.last_seen=datetime($seen)"""
            await tx.run(query, source=scoped(tenant, r.source_id), target=scoped(tenant, r.target_id),
                         properties=json.dumps(r.properties, sort_keys=True), evidence_source=r.evidence.source,
                         observed=r.evidence.observed_at.isoformat(), confidence=r.evidence.confidence,
                         seen=e.sent_at.isoformat())
        await tx.run("MATCH (a:Archetype {tenant:$tenant}) WHERE NOT (a)<-[:INSTANCE_OF]-() DELETE a", tenant=tenant)

    async def topology(self, tenant: str) -> dict:
        async with self.driver.session() as session:
            nodes_result = await session.run(
                """MATCH (n) WHERE (n:Asset OR n:Archetype) AND n.tenant = $tenant
                   RETURN CASE WHEN n:Archetype THEN 'archetype:' + n.hash ELSE n.id END AS id,
                          labels(n) AS labels, properties(n) AS properties LIMIT 10001""", tenant=tenant,
            )
            rels_result = await session.run(
                """MATCH (a:Asset {tenant:$tenant})-[r]->(b) WHERE (b:Asset OR b:Archetype) AND b.tenant = $tenant
                   RETURN a.id AS source,
                          CASE WHEN b:Archetype THEN 'archetype:' + b.hash ELSE b.id END AS target,
                          type(r) AS kind, properties(r) AS properties LIMIT 30001""", tenant=tenant,
            )
            nodes = [_json_safe(_public(dict(x))) async for x in nodes_result]
            edges = [_json_safe(dict(x)) async for x in rels_result]
            return resolve_workload_endpoints({"nodes": nodes[:10000], "edges": edges[:30000],
                    "truncated_nodes": len(nodes) > 10000, "truncated_edges": len(edges) > 30000})

    async def classify(self, tenant: str, asset_id: str, entry: bool, critical: bool) -> bool:
        async with self.driver.session() as session:
            result = await session.run(
                "MATCH (n:Asset {key:$key}) SET n.entry=$entry,n.critical=$critical RETURN count(n) AS changed",
                key=scoped(tenant, asset_id), entry=entry, critical=critical,
            )
            record = await result.single()
            return bool(record and record["changed"])

    async def record_confirmations(self, tenant: str, transitions: list[dict], recorded_at: str) -> int:
        """Write sandbox-confirmed hops. Agent envelopes can neither submit nor replace these edges."""
        written = 0
        async with self.driver.session() as session:
            for hop in transitions:
                result = await session.run(
                    """MATCH (s:Host:Asset {key:$source}),(t:Host:Asset {key:$target})
                       MERGE (s)-[r:CONFIRMED_ATTACK_TRANSITION]->(t)
                       SET r.properties_json=$properties,r.evidence_source=$evidence_source,
                           r.observed_at=datetime($at),r.confidence='confirmed',r.last_seen=datetime($at)
                       RETURN count(r) AS n""",
                    source=scoped(tenant, hop["source"]), target=scoped(tenant, hop["target"]),
                    properties=json.dumps(hop["properties"], sort_keys=True),
                    evidence_source="sandbox:" + str(hop["properties"].get("run_id", "")), at=recorded_at)
                record = await result.single()
                written += int(record["n"]) if record else 0
        return written

    async def candidate_paths(self, tenant: str, max_depth: int) -> list[list[dict]]:
        return analyze_paths(await self.topology(tenant), [], max_depth)["paths"]


def _public(row):
    """Storage-only scoping fields are not part of the API's node properties."""
    row["properties"] = {k: v for k, v in row["properties"].items() if k not in {"key", "tenant"}}
    return row


def _json_safe(value):
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if hasattr(value, "iso_format"):
        return value.iso_format()
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value
