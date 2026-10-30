import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@elemental/loader-smoke'
const binScript = fileURLToPath(new URL('./fixtures/elemental-badge/snapshot.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/elemental-badge/cordis.yml', import.meta.url))
const defaultConfigPath = fileURLToPath(new URL('./fixtures/elemental-badge/default.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const badgeAssetsPath = fileURLToPath(new URL('../../../packages/skill/skill-badge/assets/', import.meta.url))

describe('elemental badge assembled snapshot', () => {
  it('advertises and loads the opt-in bundled skill through the shipped app', async () => {
    const disabled = await runLoaderSmoke({
      label: 'disabled elemental badge skill snapshot',
      tempDirPrefix: 'headless-snapshot-elemental-badge-disabled-',
      binScript,
      libBinScript: binScript,
      configPath: defaultConfigPath,
      tsconfigPath,
    })
    const enabled = await runLoaderSmoke({
      label: 'elemental badge skill snapshot',
      tempDirPrefix: 'headless-snapshot-elemental-badge-',
      binScript,
      libBinScript: binScript,
      configPath,
      tsconfigPath,
    })
    const disabledSnapshot = JSON.parse(disabled.stdout) as unknown
    const enabledSnapshot = JSON.parse(
      enabled.stdout.replaceAll(badgeAssetsPath, '{{badgeAssetsPath}}'),
    ) as unknown

    expect(disabled.stderr).toBe('')
    expect(enabled.stderr).toBe('')
    expect(disabledSnapshot).toMatchInlineSnapshot(`
      {
        "catalog": null,
        "result": {
          "content": [
            {
              "text": "Error: skill "elemental-badge" is unknown or no longer available",
              "type": "text",
            },
          ],
          "error": {
            "message": "skill "elemental-badge" is unknown or no longer available",
          },
          "isError": true,
        },
        "summary": null,
      }
    `)
    expect(enabledSnapshot).toMatchInlineSnapshot(`
      {
        "catalog": [
          {
            "text": "<system-reminder>
      A skill is a reusable set of task-specific instructions. The following skills are available in this session:

      <available_skills>
      - \`elemental-badge\`: Add the official “powered by Elemental Harness” badge to documents, pull requests, merge requests, and other content produced with Elemental Harness. Use whenever creating a pull request or merge request. Also use when the user asks for an Elemental Harness badge, powered-by-Elemental-Harness attribution, or a reusable Elemental Harness badge asset or snippet.
      </available_skills>

      If the user names a skill, or the task clearly matches a skill's description, call the \`skill\` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
      A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the \`skill\` tool again for that skill.
      </system-reminder>",
            "type": "text",
          },
        ],
        "result": {
          "content": [
            {
              "text": "<skill_content name="elemental-badge">
      <skill_resources>
      Base directory for this skill: {{badgeAssetsPath}}
      Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
      </skill_resources>

      <skill_instructions>
      # Elemental Harness Badge

      Add the official “powered by Elemental Harness” badge without recreating or restyling it.

      ## Assets

      - Local PNG: [\`elemental-badge.png\`](elemental-badge.png), 1148×120 source image; render at 191×20
      - Shields.io image URL: \`https://img.shields.io/badge/powered_by-Elemental_Harness-0F766E?style=flat-square\`
      - Project URL: \`https://github.com/poojarishreyas/Elemental_harness\`

      ## Markdown

      Use this linked badge in Markdown:

      \`\`\`markdown
      [![](https://img.shields.io/badge/powered_by-Elemental_Harness-0F766E?style=flat-square)](https://github.com/poojarishreyas/Elemental_harness)
      \`\`\`

      If attribution should not be linked, use:

      \`\`\`markdown
      ![](https://img.shields.io/badge/powered_by-Elemental_Harness-0F766E?style=flat-square)
      \`\`\`

      ## Usage rules

      - For GitHub or GitLab Markdown, use the Shields.io URL and link it to the project URL unless the user asks for an unlinked image.
      - For Feishu and other systems that import remote images unreliably, upload \`elemental-badge.png\` from this skill directory instead of generating another badge.
      - Preserve the badge's 191×20 dimensions and aspect ratio.
      - Place the badge at the end of the attributed document or section unless the user specifies another position.
      - Do not substitute another color, logo, label, or project URL.

      </skill_instructions>
      </skill_content>",
              "type": "text",
            },
          ],
          "isError": false,
          "value": {
            "content": "# Elemental Harness Badge

      Add the official “powered by Elemental Harness” badge without recreating or restyling it.

      ## Assets

      - Local PNG: [\`elemental-badge.png\`](elemental-badge.png), 1148×120 source image; render at 191×20
      - Shields.io image URL: \`https://img.shields.io/badge/powered_by-Elemental_Harness-0F766E?style=flat-square\`
      - Project URL: \`https://github.com/poojarishreyas/Elemental_harness\`

      ## Markdown

      Use this linked badge in Markdown:

      \`\`\`markdown
      [![](https://img.shields.io/badge/powered_by-Elemental_Harness-0F766E?style=flat-square)](https://github.com/poojarishreyas/Elemental_harness)
      \`\`\`

      If attribution should not be linked, use:

      \`\`\`markdown
      ![](https://img.shields.io/badge/powered_by-Elemental_Harness-0F766E?style=flat-square)
      \`\`\`

      ## Usage rules

      - For GitHub or GitLab Markdown, use the Shields.io URL and link it to the project URL unless the user asks for an unlinked image.
      - For Feishu and other systems that import remote images unreliably, upload \`elemental-badge.png\` from this skill directory instead of generating another badge.
      - Preserve the badge's 191×20 dimensions and aspect ratio.
      - Place the badge at the end of the attributed document or section unless the user specifies another position.
      - Do not substitute another color, logo, label, or project URL.
      ",
            "name": "elemental-badge",
            "provider": "elemental-badge",
            "resourceBase": {
              "kind": "directory",
              "path": "{{badgeAssetsPath}}",
            },
          },
        },
        "summary": {
          "description": "Add the official “powered by Elemental Harness” badge to documents, pull requests, merge requests, and other content produced with Elemental Harness. Use whenever creating a pull request or merge request. Also use when the user asks for an Elemental Harness badge, powered-by-Elemental-Harness attribution, or a reusable Elemental Harness badge asset or snippet.",
          "invocation": {
            "modelInvocable": true,
            "userInvocable": true,
          },
          "name": "elemental-badge",
          "provider": "elemental-badge",
          "resourceBase": {
            "kind": "directory",
            "path": "{{badgeAssetsPath}}",
          },
          "source": "bundled",
        },
      }
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS * 2)
})
