---
name: security-review
description: Review code against concrete trust-boundary and abuse risks. Invoke for auth, permissions, commands, paths, network access, parsing, or secret handling.
version: 1.0.0
agentTypes:
  - code
mcp: []
---

# Security Review

Assess reachable security failures using explicit attacker capabilities and trust boundaries.

## Workflow

1. Define protected assets, trusted components, untrusted inputs, and attacker capabilities.
2. Trace data across authentication, authorization, process, filesystem, network, and persistence boundaries.
3. Inspect validation at the boundary where data changes trust level.
4. Check relevant risks:
   - Injection into commands, queries, templates, or interpreters.
   - Path traversal, symlink escape, unsafe temporary files, and permission mistakes.
   - Authentication bypass, authorization gaps, and confused-deputy behavior.
   - SSRF, unsafe redirects, weak transport policy, and unrestricted egress.
   - Deserialization, parser differentials, resource exhaustion, and unbounded inputs.
   - Secret exposure through logs, errors, storage, prompts, or responses.
   - Race conditions and time-of-check/time-of-use defects.
   - Insecure defaults, downgrade paths, and missing audit evidence.
5. Confirm each finding has a plausible input path and security impact.

## Finding Format

For each finding, include severity, confidence, affected file and line, prerequisites, exploit path,
impact, and a concrete remediation.

## Constraints

- Do not reveal real credentials or sensitive user data.
- Do not label a theoretical concern as exploitable without supporting evidence.
- Distinguish defense-in-depth improvements from vulnerabilities.
- Do not modify code unless the user explicitly asks for fixes.
- If no findings remain, state that clearly and identify unreviewed boundaries or tests.
