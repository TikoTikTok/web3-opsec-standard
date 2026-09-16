# Contributing

We welcome contributions to help improve the W3OS standard.

Join the [Telegram group](https://t.me/+yhmMnY2DyNBmNDlh) to collaborate with the community.

## How to Propose a Change

1. Fork or clone the repo.
2. Make your changes.
3. Submit a PR that includes:
   - What you changed and why.
   - Your organization added to the Contributors section of the README.
4. Admins will review and merge.

## What to Add

- **Domains**  
  OpSec is broad, and new domains are welcome. Do not add anything related to written application code. W3OS is strictly scoped to **non-code** security issues (infrastructure-as-code guidance is acceptable).

- **Risks**  
  Each domain has security risks that its requirements are designed to protect against. Risks explain why requirements are important and should be clearly described and impactful to security.

- **Requirements**  
  Requirements define the necessary security properties an organization must meet to defend against the defined risks. Keep them general, outlining the approach to mitigate risks.

- **Guides**  
  Guides are specific steps to meet requirements. They should be as actionable as possible (for example: “Click **Settings > Security > Require MFA** on all admin accounts” rather than “Enable MFA”).

## Style Guidelines

- Configuration guide checklist items follow the channel-first format described in [schema/guide-format.md](schema/guide-format.md): a pass condition on the item line, then Console and CLI blocks with Verify, Expect and Fix lines. `node scripts/validate.js` enforces it and `node scripts/build-manifest.js` regenerates `manifest.json`, which must be committed with your change.

- Keep language simple and concise.
- Use **must** for strict requirements, **should** for strong recommendations, and **can** for optional suggestions.
- Be specific. Avoid vague instructions like “Monitor network traffic.” Instead, give actionable steps such as “Use Little Snitch on endpoints to monitor connection requests and block unknown domains by default.”
- Focus on organizational security. Individual guidance is only acceptable if it can be implemented at an organizational level (for example, “Undergo phishing training” is individual, while “Track phishing training completion for all staff” is organizational).
