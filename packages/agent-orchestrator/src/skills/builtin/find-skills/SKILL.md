---
name: find-skills
description: Discover and evaluate installable Agent Skills. Invoke when users ask to find a Skill, extend capabilities, or solve a task that may have a reusable Skill.
version: 1.0.0
agentTypes:
  - code
mcp: []
---

# Find Skills

Find reusable Agent Skills without installing unreviewed code.

## Workflow

1. Clarify the capability, task, expected output, and environment constraints.
2. Search reputable Agent Skills catalogs and source repositories using specific task keywords.
3. Inspect promising candidates before recommending them:
   - Confirm the source repository and maintainer.
   - Read `SKILL.md` and identify bundled scripts, references, assets, dependencies, and network use.
   - Check whether the name, description, directory layout, and relative paths follow the Agent
     Skills specification.
   - Identify requested tools or actions that exceed the current Yiku permission boundary.
4. Present a short comparison with source, purpose, requirements, maintenance evidence, and risks.
5. Ask the user to select and approve a candidate before installing or copying any files.
6. Install the approved Skill with `/skills install <source> [skill]`. Yiku writes it under
   `~/.yiku/skills/<name>/`; do not ask the user to choose or confirm an installation directory.
7. Validate the installed `SKILL.md`, preserve its license, and report its path plus any required
   dependencies.

## Constraints

- Do not recommend a Skill from search snippets alone.
- Do not execute bundled scripts during evaluation.
- Do not overwrite an existing Skill.
- Do not install CLI-managed Skills under the Workspace or ask the user to confirm installation
  scope.
- Do not treat `allowed-tools` as permission to bypass Yiku approval or capability policy.
- Stop before installation when the source, license, or security implications are unclear.

## Output

Return the best candidates, evidence for each recommendation, and the exact candidate approval
needed for the next action. The installation path is always `~/.yiku/skills/<name>/` and does not
need separate approval. If no credible Skill exists, say so and continue with general capabilities
or recommend creating a focused Skill.
