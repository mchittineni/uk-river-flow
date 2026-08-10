# Security policy

## What this project is

A static site and a scheduled data pipeline. There is no server, no database, no
user accounts, no authentication, no cookies and no analytics. It stores nothing
about visitors, and it holds no secrets — every upstream API it uses is keyless and
public, which is a deliberate design property, not an accident.

That narrows the realistic attack surface considerably, but it does not eliminate it.

## In scope

- **Supply chain**: a malicious or compromised npm dependency, or a compromised
  GitHub Action. Dependencies are pinned via lockfile and Dependabot is enabled.
- **Workflow injection**: a GitHub Actions workflow interpolating untrusted event
  data into a shell. The workflows here deliberately avoid it, and each carries a
  comment saying so; a case we missed is a valid report.
- **Cross-site scripting**: the front end renders third-party open data (station and
  river names). The UI is built entirely through `web/src/dom.js`, which routes all
  text through `textContent` — `innerHTML` is not used anywhere. A path that reaches
  the DOM as markup is a valid report.
- **Excessive permissions**: any workflow whose `permissions:` block is broader than
  its job needs.
- **Data integrity**: a way to make the pipeline publish values that misrepresent the
  upstream source, bypassing `pipeline/validate_data.py`.

## Out of scope

- Vulnerabilities in the upstream data providers. Report those to them.
- Availability of free third-party services (tile hosts, Overpass, the data APIs).
- Missing security headers that a static host does not let us set.
- Anything requiring write access to this repository to exploit.

## Reporting

Use **GitHub's private vulnerability reporting** (Security tab → Report a
vulnerability). That keeps the report private until a fix exists.

Please do not open a public issue for a vulnerability. For anything non-sensitive, a
normal issue is perfect.

Expect an acknowledgement within a week. This is a spare-time project, so please be
patient with timelines — and do tell us if you plan to disclose publicly, so we can
line up a fix.
