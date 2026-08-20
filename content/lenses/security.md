---
category: correctness
---

# Security

Perform a security-focused review to identify HIGH-CONFIDENCE security
vulnerabilities that could have real exploitation potential. This is not a
general code review — focus ONLY on security implications newly added by this
change. Do not comment on existing security concerns.

Critical instructions:

1. MINIMIZE FALSE POSITIVES: Only flag issues where you're >80% confident of
   actual exploitability
2. AVOID NOISE: Skip theoretical issues, style concerns, or low-impact
   findings
3. FOCUS ON IMPACT: Prioritize vulnerabilities that could lead to unauthorized
   access, data breaches, or system compromise

## Security categories to examine

**Input Validation Vulnerabilities:**

- SQL injection via unsanitized user input
- Command injection in system calls or subprocesses
- XXE injection in XML parsing
- Template injection in templating engines
- NoSQL injection in database queries
- Path traversal in file operations

**Authentication & Authorization Issues:**

- Authentication bypass logic
- Privilege escalation paths
- Session management flaws
- JWT token vulnerabilities
- Authorization logic bypasses

**Crypto & Secrets Management:**

- Hardcoded API keys, passwords, or tokens
- Weak cryptographic algorithms or implementations
- Improper key storage or management
- Cryptographic randomness issues
- Certificate validation bypasses

**Injection & Code Execution:**

- Remote code execution via deserialization
- Pickle injection in Python
- YAML deserialization vulnerabilities
- Eval injection in dynamic code execution
- XSS vulnerabilities in web applications (reflected, stored, DOM-based)

**Data Exposure:**

- Sensitive data logging or storage
- PII handling violations
- API endpoint data leakage
- Debug information exposure

Even if something is only exploitable from the local network, it can still be
a HIGH severity issue.

## Analysis methodology

Phase 1 — Repository context research:

- Identify existing security frameworks and libraries in use
- Look for established secure coding patterns in the codebase
- Examine existing sanitization and validation patterns
- Understand the project's security model and threat model

Phase 2 — Comparative analysis:

- Compare new code changes against existing security patterns
- Identify deviations from established secure practices
- Look for inconsistent security implementations
- Flag code that introduces new attack surfaces

Phase 3 — Vulnerability assessment:

- Examine each modified file for security implications
- Trace data flow from user inputs to sensitive operations
- Look for privilege boundaries being crossed unsafely
- Identify injection points and unsafe deserialization

## Do not report

- Denial of Service (DOS) vulnerabilities or resource exhaustion attacks
- Secrets/credentials stored on disk (these are managed separately)
- Rate limiting concerns or service overload scenarios. Services do not need
  to implement rate limiting.
- Memory consumption or CPU exhaustion issues.
- Lack of input validation on non-security-critical fields. If there isn't a
  proven problem from a lack of input validation, don't report it.

Better to miss some theoretical issues than flood the report with false
positives. Each finding should be something a security engineer would
confidently raise in a review. State each claimed failure as the exploit
scenario: the attacker-controlled input and the impact.
