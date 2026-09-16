# Guide Item Format

Every checklist item in a CONFIGURATION guide states what passing looks like, then tells the reader how to check and fix it through each channel they might use. The item line is the stable identity of the control; everything under it is instruction.

## Shape

```markdown
- [ ] **Item Title** - pass: <the exact condition that means this item is done>
  - **Console**:
    - Verify: <Product> > <Section> > <Page> > <what to read, and the value that passes>
    - Fix: <Product> > <Section> > <Page> > <the action to take>
  - **CLI**:
    - Verify: `<command>`
    - Expect: <what the output looks like when the item passes>. <One clause on why the failing state matters.>
    - Fix: `<command>`
```

## Rules

1. **Item line.** `- [ ] **Title** - pass: <condition>`. The title is the key the sync engine uses to carry progress across edits, so never rename an item as part of a content change. The pass condition names the field and value that count as done.
2. **Blocks.** `**Console**:` first, then `**CLI**:`. Include both whenever both channels can check or change the setting. Omit a block only when that channel genuinely has no way to do it; do not add a line explaining the absence. Every item has at least one block.
3. **Console lines.** One `Verify:` and one `Fix:`. Each is a complete click path from the product's top-level navigation, segments separated by ` > `, ending with what to read (Verify) or what to do (Fix). Write every path in full. Never refer to another line ("same page as above").
4. **CLI lines.** One or more `Verify:` lines, one per command. Exactly one `Expect:` line after them. Then zero or more `Fix:` lines. If there is no CLI fix, leave Fix out of the CLI block and rely on the Console Fix.
5. **Expect.** States the exact output, field or value that passes, then one clause on why the failing state matters. Nothing else in the item repeats this.
6. **Commands.** Inline backticks for a one-liner up to about 100 characters with no pipe or loop. Anything longer, or with a pipe or loop, goes in a fenced block with the `bash` info string on the line after the label, indented to the bullet's content column:

   ````markdown
       - Verify:
         ```bash
         aws iam list-users --query 'Users[].UserName' --output text | tr '\t' '\n' | while read u; do
           aws iam list-access-keys --user-name "$u" --query "AccessKeyMetadata[?Status=='Active'].[UserName,AccessKeyId]" --output table
         done
         ```
   ````

   A fence must never contain the text `- [ ]`.
7. **Placeholders** in angle brackets: `<sg>`, `<project-id>`, `<user>`.
8. **Indentation.** Two spaces per level. Sub-bullets are plain `-`, never `- [ ]`.
9. **Characters.** ASCII only. Hyphen-minus for dashes, straight quotes, `>` as the path separator.
10. **Prerequisites.** Region and project iteration, environment variables like `$ORG_ID`, and required roles live once in the file's Prerequisites block. Items assume them rather than repeating them.

## Worked example

```markdown
- [ ] **Unrestricted SSH Access** - pass: no security group allows port 22 from `0.0.0.0/0` or `::/0`
  - **Console**:
    - Verify: EC2 > Security Groups > filter `Port range: 22` > Source column shows no `0.0.0.0/0` or `::/0`
    - Fix: EC2 > Security Groups > select the group > Inbound rules > Edit inbound rules > delete the rule > Save rules
  - **CLI**:
    - Verify: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=22 Name=ip-permission.to-port,Values=22 Name=ip-permission.cidr,Values=0.0.0.0/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
    - Verify: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=22 Name=ip-permission.to-port,Values=22 Name=ip-permission.ipv6-cidr,Values=::/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
    - Expect: both commands return an empty table. A group open to the world on 22 is the first thing every scanner finds.
    - Fix: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 22 --cidr 0.0.0.0/0`
```

## Validation

`node scripts/validate.js` enforces this shape for every guide that uses a Console or CLI block. It checks the block and label names, that each item has a pass condition and at least one block, that Console has Verify and Fix, that CLI has at least one Verify and exactly one Expect, that fences are indented inside their bullet and contain no checkbox, and that no line contains non-ASCII characters.

`node scripts/build-manifest.js` parses every guide into `manifest.json` in the shape of `schema/w3os-content.schema.json`. Guides in this format get a structured `items` array there, one entry per checklist item with `title`, `pass`, `console` and `cli`. Commit the regenerated manifest with any guide change; CI fails when it is stale.
