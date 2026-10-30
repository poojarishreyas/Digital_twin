CREATE CONSTRAINT asset_id IF NOT EXISTS FOR (n:Asset) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT archetype_hash IF NOT EXISTS FOR (n:Archetype) REQUIRE n.hash IS UNIQUE;
CREATE INDEX component_kind IF NOT EXISTS FOR (n:Component) ON (n.kind);
CREATE INDEX host_last_seen IF NOT EXISTS FOR (n:Host) ON (n.last_seen);

