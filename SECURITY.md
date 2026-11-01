# Security Policy

pitlane runs other people's code on your host: its tiers, accounts and guards are what keep one job
from reaching another job, a lane's keys, or root. A report that breaks one of those gets priority.

## Reporting a vulnerability

Please **do not open a public issue** for security reports.

- **Preferred:** [GitHub private vulnerability reporting](https://github.com/askalf/pitlane/security/advisories/new),
  which opens a private advisory only the maintainers see.
- **Email:** support@askalf.org with `pitlane security` in the subject.

You'll get an acknowledgement within 72 hours. Please include a minimal reproduction where you can.

## Supported versions

Only the latest release receives security fixes; there are no maintenance branches.

## In scope

Anything that breaks a boundary pitlane draws:

- A job on one row reading or writing another row's workspace, tool cache or account
- A job reading a key file of a lane it does not belong to
- A job reaching a build row (root) that the build guard's allow list does not name, or any step of a
  refused job running
- A token, JIT configuration or registration secret reaching a job, a log, a process argument or a
  run page
- The dispatcher or the supervisor being driven by data a job controls (a label, a branch, a
  workflow name) into starting, stopping or registering a row it should not

## Out of scope

- What a workflow you choose to run does with the permissions you grant it
- Denial of service by queuing many jobs within your own caps
- Findings that need root on the host already
