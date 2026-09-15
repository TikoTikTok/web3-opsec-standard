<!--
id: aws-cloud-security
type: CONFIGURATION
scope: ORGANIZATION
-->

<div align="center">
  <img src="../../../../images/guides/aws.svg" alt="AWS Logo" width="64" height="64">
  <h2><a href="https://aws.amazon.com/" target="_blank" rel="noopener noreferrer">AWS</a> Configuration Guide</h2>
  <p><em>Identity, Network, Data, and Detection controls for AWS accounts</em></p>
</div>

---

## How to Use This Guide

Every checklist item below states its **pass condition** on the item line itself, then breaks into three parts:

- **Run** - the command that collects the current state. Copy it as-is; replace only the `<placeholders>`.
- **Verify** - the same condition in full: the exact field and value that counts as a pass, and why the failing state matters. If the output does not match, the item fails.
- **Fix** - the command or console path that remediates it.

The condition is repeated on the item line so the control stays self-contained wherever the checklist is consumed as a flat list of items.

An item is only complete when **Verify** passes for *every* resource the command returns, not just the first one.

#### Prerequisites

- AWS CLI v2 - check with `aws --version`.
- Confirm which account you are auditing: `aws sts get-caller-identity`
- A read-only principal is enough for every **Run** command. Attach the AWS-managed `SecurityAudit` and `ViewOnlyAccess` policies.
- **Most checks are regional.** IAM, S3 bucket listing, Organizations and account-level settings are global; everything else must be repeated per region. To sweep every enabled region:
  - `for r in $(aws ec2 describe-regions --query 'Regions[].RegionName' --output text); do echo "== $r"; AWS_REGION=$r <command>; done`
- Several IAM checks read the credential report. Generate it once before you start - the first call returns `STARTED`, so run it twice:
  - `aws iam generate-credential-report`
- In a multi-account Organization, run the whole guide in each member account. Organization-wide controls (SCPs, the Organization CloudTrail, the Access Analyzer) are checked from the management account.

---

## Identity & Access (IAM)

#### Root Account

- [ ] **Root Account Access Keys Present** - pass: `AccountAccessKeysPresent` = `0`
  - **Run**: `aws iam get-account-summary --query 'SummaryMap.AccountAccessKeysPresent'`
  - **Verify**: `0`. Any other value means the root user has a long-lived access key. Root keys cannot be scoped, restricted by policy, or denied by an SCP - one leak is unlimited access to the account.
  - **Fix**: sign in as root > **My Security Credentials > Access keys** > delete every key. There is no supported use for a root access key; anything automated should use an IAM role.

- [ ] **Root MFA Enabled** - pass: `AccountMFAEnabled` = `1`
  - **Run**: `aws iam get-account-summary --query 'SummaryMap.AccountMFAEnabled'`
  - **Verify**: `1`. Without MFA, the root password alone controls the account, including billing and account closure.
  - **Fix**: sign in as root > **My Security Credentials > Multi-factor authentication (MFA) > Assign MFA device**. Store the device with your break-glass material, not on an admin's daily laptop.

- [ ] **Root Account Credentials Usage** - pass: no root sign-in since the last recorded break-glass event
  - **Run**: `aws iam get-credential-report --query Content --output text | base64 --decode | awk -F, 'NR==1 || $1=="<root_account>" {print $1", "$5", "$11", "$16}'`
  - **Verify**: `password_last_used` is `no_information`, or a date you can tie to a specific approved task (account setup, a support case, an SCP change). An unexplained recent date is an incident, not a finding.
  - **Fix**: stop using root for routine work - it is needed for only a handful of tasks. Add a detective control: a CloudWatch metric filter on `{ $.userIdentity.type = "Root" }` over the CloudTrail log group, with an alarm to an on-call topic.

- [ ] **Hardware MFA for AWS Root Account** - pass: `AccountMFAEnabled` = `1` with no virtual MFA device on root
  - **Run**: `aws iam list-virtual-mfa-devices --query "VirtualMFADevices[?ends_with(User.Arn, ':root')].SerialNumber"`
  - **Verify**: an empty list, with `AccountMFAEnabled` = `1` from the control above. A serial number here means root is protected by a software authenticator, which lives on a phone that can be lost, cloned, or restored from a backup.
  - **Fix**: sign in as root > **My Security Credentials > MFA** - register a FIDO2 security key or hardware TOTP token, then remove the virtual device. Keep a second key in a different physical location.

#### Users & Permissions

- [ ] **Enable MFA for IAM Users with Console Password** - pass: the query returns no users
  - **Run**: `aws iam get-credential-report --query Content --output text | base64 --decode | awk -F, 'NR>1 && $4=="true" && $8=="false" {print $1}'`
  - **Verify**: no output. Every name printed is a user who can sign in to the console with a password alone.
  - **Fix**: register a device per user with `aws iam enable-mfa-device --user-name <user> --serial-number <mfa-arn> --authentication-code1 <code1> --authentication-code2 <code2>`, then make it structural: attach a policy denying all actions when `aws:MultiFactorAuthPresent` is `false`. Better still, replace console users with federated SSO through IAM Identity Center.

- [ ] **IAM Users with Administrative Privileges** - pass: no IAM user holds AdministratorAccess except named break-glass accounts
  - **Run**: `aws iam list-users --query 'Users[].UserName' --output text | tr '\t' '\n' | while read u; do p=$(aws iam list-attached-user-policies --user-name "$u" --query "AttachedPolicies[?PolicyName=='AdministratorAccess'].PolicyName" --output text); [ -n "$p" ] && echo "direct: $u"; done`
  - **Verify**: no output beyond documented break-glass users. Also check inherited admin: `aws iam list-groups-for-user --user-name <user>` and the policies on those groups - admin granted through a group does not show above.
  - **Fix**: `aws iam detach-user-policy --user-name <user> --policy-arn arn:aws:iam::aws:policy/AdministratorAccess` and re-grant the narrowest managed policy that works. Standing admin belongs on a role that is assumed with MFA, not on a user.

- [ ] **IAM Policies With Full Administrative Privileges** - pass: no customer-managed policy allows Action `*` on Resource `*`
  - **Run**: `aws iam list-policies --scope Local --only-attached --query 'Policies[].Arn' --output text | tr '\t' '\n' | while read a; do echo "== $a"; aws iam get-policy-version --policy-arn "$a" --version-id "$(aws iam get-policy --policy-arn "$a" --query Policy.DefaultVersionId --output text)" --query 'PolicyVersion.Document.Statement'; done`
  - **Verify**: no statement combines `"Effect": "Allow"` with `"Action": "*"` and `"Resource": "*"`. That combination is `AdministratorAccess` wearing a custom name, which is how admin survives a review that only looks for the AWS-managed policy.
  - **Fix**: rewrite with an explicit action list and resource ARNs, then publish it: `aws iam create-policy-version --policy-arn <arn> --policy-document file://policy.json --set-as-default`. Use IAM Access Analyzer policy generation to derive the real action set from CloudTrail.

- [ ] **IAM Policies with Effect Allow and NotAction** - pass: no Allow statement uses `NotAction`
  - **Run**: `aws iam list-policies --scope Local --only-attached --query 'Policies[].Arn' --output text | tr '\t' '\n' | while read a; do d=$(aws iam get-policy-version --policy-arn "$a" --version-id "$(aws iam get-policy --policy-arn "$a" --query Policy.DefaultVersionId --output text)" --query 'PolicyVersion.Document' --output json); echo "$d" | grep -q '"NotAction"' && echo "$a"; done`
  - **Verify**: no output. `Allow` with `NotAction` grants everything *except* what you listed, so every service AWS launches afterwards is permitted by default in a policy nobody revisits.
  - **Fix**: invert it - replace `NotAction` with an explicit `Action` list. `NotAction` is only safe in a `Deny` statement.

- [ ] **IAM Role Policy Too Permissive** - pass: no role holds AdministratorAccess or a wildcard inline policy
  - **Run**: `aws iam list-roles --query "Roles[?!starts_with(Path, '/aws-service-role/')].RoleName" --output text | tr '\t' '\n' | while read r; do p=$(aws iam list-attached-role-policies --role-name "$r" --query "AttachedPolicies[?PolicyName=='AdministratorAccess'].PolicyName" --output text); [ -n "$p" ] && echo "$r"; done`
  - **Verify**: only roles that genuinely need account-wide control appear, and each is documented. Also review inline policies: `aws iam list-role-policies --role-name <role>` then `aws iam get-role-policy --role-name <role> --policy-name <name>`.
  - **Fix**: `aws iam detach-role-policy --role-name <role> --policy-arn arn:aws:iam::aws:policy/AdministratorAccess` and scope to the services the workload actually calls. A role attached to compute is a credential any code on that compute can use.

- [ ] **Cross-Account Access Lacks External ID and MFA** - pass: every cross-account trust carries an `sts:ExternalId` or MFA condition
  - **Run**: `aws iam list-roles --query "Roles[?contains(to_string(AssumeRolePolicyDocument), ':root') || contains(to_string(AssumeRolePolicyDocument), ':user/')].{Role:RoleName, Trust:AssumeRolePolicyDocument}" --output json`
  - **Verify**: each role trusting a principal in another account has a `Condition` block requiring `sts:ExternalId`, or `aws:MultiFactorAuthPresent` for human access. Without one, any third party who learns your role ARN and account ID can attempt assumption - the confused deputy problem.
  - **Fix**: add `"Condition": {"StringEquals": {"sts:ExternalId": "<value agreed with the third party>"}}` to the trust policy and update it with `aws iam update-assume-role-policy --role-name <role> --policy-document file://trust.json`.

- [ ] **Check for Untrusted Cross-Account IAM Roles** - pass: every external account ID in a trust policy is known and approved
  - **Run**: `aws iam list-roles --query 'Roles[].{Role:RoleName, Trust:AssumeRolePolicyDocument}' --output json | grep -oE 'arn:aws:iam::[0-9]{12}' | sort -u` then compare against `aws organizations list-accounts --query 'Accounts[].Id' --output text`
  - **Verify**: every account ID that is not your own and not in your Organization maps to a named vendor with a current contract. Stale vendor trusts are a standing path into the account long after the engagement ends.
  - **Fix**: remove the principal from the trust policy with `aws iam update-assume-role-policy`, or delete the role entirely if nothing else uses it. Enable IAM Access Analyzer to be told about new external access as it appears.

- [ ] **Inactive IAM Console User** - pass: no console user idle for more than 90 days
  - **Run**: `aws iam get-credential-report --query Content --output text | base64 --decode | awk -F, 'NR>1 && $4=="true" {print $1", last used: "$5}'`
  - **Verify**: every console-enabled user has signed in within 90 days. Dormant accounts keep their permissions, are rarely covered by MFA reviews, and are the quietest way back into an account after offboarding.
  - **Fix**: `aws iam delete-login-profile --user-name <user>` to remove console access, and delete the user once you confirm nothing depends on it. Tie the account lifecycle to your HR offboarding process rather than to periodic review.

- [ ] **Unused IAM User** - pass: no user without console or access-key activity in 90 days
  - **Run**: `aws iam get-credential-report --query Content --output text | base64 --decode | awk -F, 'NR>1 {print $1", password: "$5", key1: "$11", key2: "$16}'`
  - **Verify**: every user shows activity within 90 days on at least one credential. A user with `N/A` across all three has never been used and should not exist.
  - **Fix**: delete the user with `aws iam delete-user --user-name <user>` after detaching policies and deleting keys. Service accounts that appear here are usually a sign that a workload has already moved to a role - confirm, then remove.

- [ ] **IAM User with Password and Access Keys** - pass: no user has both a console password and an active access key
  - **Run**: `aws iam get-credential-report --query Content --output text | base64 --decode | awk -F, 'NR>1 && $4=="true" && ($9=="true" || $14=="true") {print $1}'`
  - **Verify**: no output. A human identity with programmatic keys doubles the credential surface and means a key leak cannot be distinguished from normal human activity in CloudTrail.
  - **Fix**: decide what the identity is. For a person, `aws iam delete-access-key --user-name <user> --access-key-id <id>` and use short-lived credentials from SSO. For a workload, `aws iam delete-login-profile --user-name <user>`.

- [ ] **Unnecessary Access Keys** - pass: no active access key that has never been used
  - **Run**: `aws iam get-credential-report --query Content --output text | base64 --decode | awk -F, 'NR>1 && (($9=="true" && $11=="N/A") || ($14=="true" && $16=="N/A")) {print $1}'`
  - **Verify**: no output. An active key that has never been used is a live credential nobody is watching, and its absence from logs means a compromise produces no anomaly.
  - **Fix**: deactivate first so you can reverse it - `aws iam update-access-key --user-name <user> --access-key-id <id> --status Inactive` - then delete after a soak period with `aws iam delete-access-key`.

- [ ] **Access Keys Rotated 90 Days** - pass: no active access key older than 90 days
  - **Run**: `aws iam list-users --query 'Users[].UserName' --output text | tr '\t' '\n' | while read u; do aws iam list-access-keys --user-name "$u" --query "AccessKeyMetadata[?Status=='Active'].[UserName,AccessKeyId,CreateDate]" --output text; done`
  - **Verify**: every `CreateDate` is within 90 days. The longer a key lives, the more places it has been copied to - CI config, a laptop, a shared note.
  - **Fix**: create the replacement first, deploy it, then remove the old one: `aws iam create-access-key --user-name <user>`, update consumers, `aws iam update-access-key --status Inactive`, then `aws iam delete-access-key`. The durable fix is removing the key entirely in favour of a role.

- [ ] **IAM Access Analyzer in Use** - pass: an `ACTIVE` analyzer exists in every region in use
  - **Run**: `aws accessanalyzer list-analyzers --query "analyzers[?status=='ACTIVE'].{name:name, type:type}" --output table`
  - **Verify**: at least one active analyzer, of type `ORGANIZATION` if you use AWS Organizations. Access Analyzer is what tells you a bucket, role, key or secret has become reachable from outside your trust zone.
  - **Fix**: `aws accessanalyzer create-analyzer --analyzer-name org-analyzer --type ORGANIZATION` from the management or delegated administrator account. It is free; repeat per region.

- [ ] **MFA Device Deactivated** - pass: no unexplained `DeactivateMFADevice` event, and an alarm covers it
  - **Run**: `aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=DeactivateMFADevice --max-results 20 --query 'Events[].{Time:EventTime, By:Username}' --output table` and `aws logs describe-metric-filters --log-group-name <cloudtrail-log-group> --query "metricFilters[?contains(filterPattern, 'DeactivateMFADevice')].{name:filterName, metric:metricTransformations[0].metricName}" --output table` then `aws cloudwatch describe-alarms --query 'MetricAlarms[].{name:AlarmName, metric:MetricName, actions:AlarmActions}' --output table`
  - **Verify**: every event maps to a known device replacement, and the filter query returns a filter whose metric appears in `describe-alarms` with a non-empty `actions` list. Deactivating MFA is a standard step in an account takeover, because it is quieter than changing a password.
  - **Fix**: re-enable the device immediately and investigate the caller. Add a CloudWatch metric filter on `{ ($.eventName = "DeactivateMFADevice") || ($.eventName = "DeleteVirtualMFADevice") }` with an alarm, so the next one pages someone.

- [ ] **Privileged AWS IAM User Has Been Created** - pass: every `CreateUser` event maps to an approved request, with an alarm in place
  - **Run**: `aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=CreateUser --max-results 20 --query 'Events[].{Time:EventTime, By:Username, Resources:Resources[].ResourceName}' --output table` and `aws logs describe-metric-filters --log-group-name <cloudtrail-log-group> --query "metricFilters[?contains(filterPattern, 'CreateUser')].{name:filterName, metric:metricTransformations[0].metricName}" --output table` then `aws cloudwatch describe-alarms --query 'MetricAlarms[].{name:AlarmName, metric:MetricName, actions:AlarmActions}' --output table`
  - **Verify**: every user created in the window is one you expected, and the filter query returns a filter whose metric appears in `describe-alarms` with a non-empty `actions` list. Creating a second admin identity is how an attacker keeps access after the original entry point is closed.
  - **Fix**: delete anything unrecognised and treat it as an incident. Add a metric filter on `{ ($.eventName = "CreateUser") || ($.eventName = "AttachUserPolicy") || ($.eventName = "CreateAccessKey") }` with an alarm.

- [ ] **IAM Configuration Changes** - pass: a metric filter and alarm exist for IAM configuration changes
  - **Run**: `aws logs describe-metric-filters --log-group-name <cloudtrail-log-group> --query 'metricFilters[].{name:filterName, pattern:filterPattern}' --output table`
  - **Verify**: a filter matching IAM events (`iam.amazonaws.com`, or the specific policy and role events) exists **and** a CloudWatch alarm is attached to its metric - confirm with `aws cloudwatch describe-alarms --query 'MetricAlarms[].{name:AlarmName, metric:MetricName, actions:AlarmActions}' --output table`. A filter with no alarm produces a number nobody looks at.
  - **Fix**: `aws logs put-metric-filter --log-group-name <log-group> --filter-name IAMChanges --filter-pattern '{ ($.eventSource = "iam.amazonaws.com") && (($.eventName = "Put*Policy") || ($.eventName = "Attach*Policy") || ($.eventName = "Create*") || ($.eventName = "Delete*")) }' --metric-transformations metricName=IAMChanges,metricNamespace=CISBenchmark,metricValue=1`, then `aws cloudwatch put-metric-alarm` pointing at an SNS topic with a real subscriber.

- [ ] **Sign-In Events** - pass: a metric filter and alarm exist for console sign-in without MFA and for failed sign-ins
  - **Run**: `aws logs describe-metric-filters --log-group-name <cloudtrail-log-group> --query "metricFilters[?contains(filterPattern, 'ConsoleLogin')].{name:filterName, pattern:filterPattern, metric:metricTransformations[0].metricName}" --output table` then `aws cloudwatch describe-alarms --query 'MetricAlarms[].{name:AlarmName, metric:MetricName, actions:AlarmActions}' --output table`
  - **Verify**: filters exist for both `ConsoleLogin` with `additionalEventData.MFAUsed = "No"` and for `errorMessage = "Failed authentication"`, and each filter's `metric` appears in `describe-alarms` with a non-empty `actions` list. Password spraying is only visible if failures are counted.
  - **Fix**: `aws logs put-metric-filter --log-group-name <log-group> --filter-name ConsoleSignInWithoutMFA --filter-pattern '{ ($.eventName = "ConsoleLogin") && ($.additionalEventData.MFAUsed != "Yes") && ($.userIdentity.type = "IAMUser") }' --metric-transformations metricName=ConsoleSignInWithoutMFA,metricNamespace=CISBenchmark,metricValue=1`, plus a matching alarm.

---

## Storage (S3)

#### Public Access

- [ ] **Enable S3 Block Public Access for AWS Accounts** - pass: all four account-level block settings are `true`
  - **Run**: `aws s3control get-public-access-block --account-id $(aws sts get-caller-identity --query Account --output text) --query 'PublicAccessBlockConfiguration'`
  - **Verify**: `BlockPublicAcls`, `IgnorePublicAcls`, `BlockPublicPolicy` and `RestrictPublicBuckets` are all `true`. This is the account-wide backstop that survives a mistake in any single bucket policy. A `NoSuchPublicAccessBlockConfiguration` error means it is not configured at all.
  - **Fix**: `aws s3control put-public-access-block --account-id <account-id> --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true`. If a bucket must serve public content, front it with CloudFront and an origin access control rather than opening the account setting.

- [ ] **Enable S3 Block Public Access for S3 Buckets** - pass: all four block settings are `true` on every bucket
  - **Run**: `aws s3api list-buckets --query 'Buckets[].Name' --output text | tr '\t' '\n' | while read b; do echo "== $b"; aws s3api get-public-access-block --bucket "$b" --query 'PublicAccessBlockConfiguration' 2>&1 | tr -d '\n'; echo; done`
  - **Verify**: every bucket returns all four settings `true`. An error instead of a configuration means that bucket relies solely on the account setting, which a future administrator can relax.
  - **Fix**: `aws s3api put-public-access-block --bucket <bucket> --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true`

- [ ] **S3 Bucket Public 'READ' Access** - pass: no bucket ACL grants `AllUsers` or `AuthenticatedUsers`
  - **Run**: `aws s3api list-buckets --query 'Buckets[].Name' --output text | tr '\t' '\n' | while read b; do g=$(aws s3api get-bucket-acl --bucket "$b" --query "Grants[?contains(to_string(Grantee.URI), 'AllUsers') || contains(to_string(Grantee.URI), 'AuthenticatedUsers')].Permission" --output text 2>/dev/null); [ -n "$g" ] && echo "$b: $g"; done`
  - **Verify**: no output. `AllUsers` is the entire internet; `AuthenticatedUsers` is every AWS account holder, which is not meaningfully narrower.
  - **Fix**: `aws s3api put-bucket-acl --bucket <bucket> --acl private`, then disable ACLs entirely with `aws s3api put-bucket-ownership-controls --bucket <bucket> --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'` so the grant cannot come back.

- [ ] **S3 Bucket Public Access Via Policy** - pass: no bucket policy allows `Principal: "*"` without a restricting condition
  - **Run**: `aws s3api list-buckets --query 'Buckets[].Name' --output text | tr '\t' '\n' | while read b; do s=$(aws s3api get-bucket-policy-status --bucket "$b" --query 'PolicyStatus.IsPublic' --output text 2>/dev/null); [ "$s" = "True" ] && echo "PUBLIC: $b"; done`
  - **Verify**: no output. For any bucket flagged, read the policy with `aws s3api get-bucket-policy --bucket <bucket> --query Policy --output text` - a wildcard principal is only acceptable with a hard condition such as `aws:SourceVpce` or a CloudFront OAC.
  - **Fix**: `aws s3api delete-bucket-policy --bucket <bucket>`, or replace the wildcard principal with the specific role ARNs that need access.

- [ ] **S3 Cross Account Access** - pass: every external account in a bucket policy is known and approved
  - **Run**: `aws s3api list-buckets --query 'Buckets[].Name' --output text | tr '\t' '\n' | while read b; do p=$(aws s3api get-bucket-policy --bucket "$b" --query Policy --output text 2>/dev/null); [ -n "$p" ] && echo "$p" | grep -oE 'arn:aws:iam::[0-9]{12}' | sort -u | sed "s|^|$b: |"; done`
  - **Verify**: every account ID other than your own is a current, documented partner. Data leaves through forgotten cross-account grants more often than through public buckets.
  - **Fix**: rewrite the policy with `aws s3api put-bucket-policy` naming only current principals, and enable IAM Access Analyzer to catch the next one as it is created.

#### Logging & Detection

- [ ] **S3 Bucket Logging Enabled** - pass: every bucket has a `LoggingEnabled` target
  - **Run**: `aws s3api list-buckets --query 'Buckets[].Name' --output text | tr '\t' '\n' | while read b; do t=$(aws s3api get-bucket-logging --bucket "$b" --query 'LoggingEnabled.TargetBucket' --output text 2>/dev/null); echo "$b: ${t:-NONE}"; done`
  - **Verify**: no bucket shows `NONE` or `None`, except the log target itself. Without access logging there is no record of what an attacker read, which turns a contained incident into an unbounded disclosure notification.
  - **Fix**: `aws s3api put-bucket-logging --bucket <bucket> --bucket-logging-status '{"LoggingEnabled":{"TargetBucket":"<log-bucket>","TargetPrefix":"<bucket>/"}}'`. Send logs to a dedicated bucket in a separate account with object lock.

- [ ] **S3 Configuration Changes** - pass: a metric filter and alarm exist for S3 policy and ACL changes
  - **Run**: `aws logs describe-metric-filters --log-group-name <cloudtrail-log-group> --query "metricFilters[?contains(filterPattern, 's3.amazonaws.com')].{name:filterName, pattern:filterPattern, metric:metricTransformations[0].metricName}" --output table` then `aws cloudwatch describe-alarms --query 'MetricAlarms[].{name:AlarmName, metric:MetricName, actions:AlarmActions}' --output table`
  - **Verify**: a filter covering `PutBucketPolicy`, `PutBucketAcl`, `DeleteBucketPolicy` and `PutBucketPublicAccessBlock` exists, and its `metric` appears in `describe-alarms` with a non-empty `actions` list. Making a bucket public is a single API call.
  - **Fix**: `aws logs put-metric-filter --log-group-name <log-group> --filter-name S3PolicyChanges --filter-pattern '{ ($.eventSource = "s3.amazonaws.com") && (($.eventName = "PutBucketAcl") || ($.eventName = "PutBucketPolicy") || ($.eventName = "DeleteBucketPolicy") || ($.eventName = "PutBucketPublicAccessBlock")) }' --metric-transformations metricName=S3PolicyChanges,metricNamespace=CISBenchmark,metricValue=1`, plus an alarm.

- [ ] **Publicly Accessible CloudTrail Buckets** - pass: no CloudTrail bucket is public
  - **Run**: `aws cloudtrail describe-trails --query 'trailList[].S3BucketName' --output text | tr '\t' '\n' | sort -u | while read b; do echo "$b: $(aws s3api get-bucket-policy-status --bucket "$b" --query 'PolicyStatus.IsPublic' --output text 2>/dev/null)"; done`
  - **Verify**: `False` for every bucket. A public CloudTrail bucket hands over a complete map of your account - principals, resources, API patterns - and lets an attacker confirm whether their activity was recorded.
  - **Fix**: `aws s3api put-public-access-block --bucket <bucket> --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true` and remove the offending policy statement. Treat any prior exposure as a disclosure of your account topology.

---

## Compute (EC2)

#### Network Exposure

- [ ] **EC2 Instance Not In Public Subnet** - pass: no application or data instance sits in a subnet with a route to an internet gateway
  - **Run**: `aws ec2 describe-instances --query "Reservations[].Instances[].{id:InstanceId, subnet:SubnetId, public:PublicIpAddress, name:Tags[?Key=='Name'].Value|[0]}" --output table`
  - **Verify**: only instances that must terminate inbound traffic (a bastion, a public load balancer target) have a `public` address. For each subnet listed, confirm its route table with `aws ec2 describe-route-tables --filters Name=association.subnet-id,Values=<subnet>` - a `0.0.0.0/0` route to an `igw-` makes it public.
  - **Fix**: move the workload to a private subnet behind a NAT gateway or an ALB, and reach it with SSM Session Manager rather than a public IP.

- [ ] **Disable Public IP Address Assignment for EC2 Instances** - pass: `MapPublicIpOnLaunch` = `false` on every subnet
  - **Run**: `aws ec2 describe-subnets --query 'Subnets[].{id:SubnetId, vpc:VpcId, autoPublicIp:MapPublicIpOnLaunch}' --output table`
  - **Verify**: `autoPublicIp` is `False` everywhere except deliberately public subnets. When it is `True`, every instance launched into that subnet becomes internet-reachable by default, including ones launched by autoscaling.
  - **Fix**: `aws ec2 modify-subnet-attribute --subnet-id <subnet> --no-map-public-ip-on-launch`. Existing instances keep their addresses - release them separately.

- [ ] **App-Tier Publicly Shared AMI** - pass: no AMI backing an application-tier instance is public
  - **Run**: `aws ec2 describe-instances --query 'Reservations[].Instances[].ImageId' --output text | tr '\t' '\n' | sort -u | while read i; do p=$(aws ec2 describe-images --image-ids "$i" --query 'Images[0].Public' --output text 2>/dev/null); [ "$p" = "True" ] && echo "public AMI in use: $i"; done`
  - **Verify**: no output. This narrows the **Publicly Shared AMI** check below to the images actually running your application, where the blast radius of a leaked image is highest.
  - **Fix**: as in **Publicly Shared AMI** below, remove the public launch permission, then rebuild the affected instances from a private image and rotate anything the old image contained.

- [ ] **Publicly Shared AMI** - pass: no owned AMI has public launch permission
  - **Run**: `aws ec2 describe-images --owners self --query "Images[?Public].{id:ImageId, name:Name}" --output table`
  - **Verify**: no rows. A public AMI can be launched by anyone, and images routinely carry baked-in credentials, source code, and internal hostnames in their filesystem.
  - **Fix**: `aws ec2 modify-image-attribute --image-id <ami> --launch-permission "Remove=[{Group=all}]"`. Treat anything previously public as disclosed: rotate every credential that was in the image.

- [ ] **AMI Cross-Account Access** - pass: every account with AMI launch permission is known and approved
  - **Run**: `aws ec2 describe-images --owners self --query 'Images[].ImageId' --output text | tr '\t' '\n' | while read i; do a=$(aws ec2 describe-image-attribute --image-id "$i" --attribute launchPermission --query 'LaunchPermissions[].UserId' --output text); [ -n "$a" ] && echo "$i: $a"; done`
  - **Verify**: every account ID is a current member of your Organization or a documented partner. Shared AMIs are copied on first launch, so revoking access later does not recall what was taken.
  - **Fix**: `aws ec2 modify-image-attribute --image-id <ami> --launch-permission "Remove=[{UserId=<account-id>}]"`

#### Instance Security

- [ ] **EC2 Instance Using IAM Roles** - pass: every instance has an `IamInstanceProfile`
  - **Run**: `aws ec2 describe-instances --query "Reservations[].Instances[?State.Name=='running'].{id:InstanceId, profile:IamInstanceProfile.Arn}" --output table`
  - **Verify**: no instance has a null `profile`. An instance without a role is almost always authenticating with a static access key written into the filesystem or an environment variable.
  - **Fix**: `aws ec2 associate-iam-instance-profile --instance-id <id> --iam-instance-profile Name=<profile>`, then delete the access key it replaces and rotate it.

- [ ] **Require IMDSv2 for EC2 Instances** - pass: `HttpTokens` = `required` on every instance
  - **Run**: `aws ec2 describe-instances --query "Reservations[].Instances[?State.Name=='running'].{id:InstanceId, tokens:MetadataOptions.HttpTokens, hops:MetadataOptions.HttpPutResponseHopLimit}" --output table`
  - **Verify**: `tokens` is `required` and `hops` is `1`. With `optional`, a server-side request forgery in your application can read the instance's role credentials with a single unauthenticated GET - the mechanism behind several large cloud breaches.
  - **Fix**: `aws ec2 modify-instance-metadata-options --instance-id <id> --http-tokens required --http-endpoint enabled --http-put-response-hop-limit 1`. Set it at launch too, and enforce with the `ec2:MetadataHttpTokens` condition key in an SCP.

#### Security Groups

Run each port check twice - once for IPv4 and once for IPv6. The `ip-permission.cidr` filter matches IPv4 only, so a rule opened to `::/0` is invisible to it.

- [ ] **Default Security Group Unrestricted** - pass: every default security group has no ingress and no egress rules
  - **Run**: `aws ec2 describe-security-groups --filters Name=group-name,Values=default --query 'SecurityGroups[].{id:GroupId, vpc:VpcId, ingress:length(IpPermissions), egress:length(IpPermissionsEgress)}' --output table`
  - **Verify**: `ingress` and `egress` are both `0`. The default group is attached to anything launched without an explicit group, so its rules apply to resources nobody meant to expose.
  - **Fix**: `aws ec2 revoke-security-group-ingress --group-id <sg> --ip-permissions "$(aws ec2 describe-security-groups --group-ids <sg> --query 'SecurityGroups[0].IpPermissions' --output json)"` and the same for egress with `revoke-security-group-egress`. The group cannot be deleted; strip it instead, and give every workload a purpose-built group.

- [ ] **Unrestricted SSH Access** - pass: no security group allows port 22 from `0.0.0.0/0` or `::/0`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=22 Name=ip-permission.to-port,Values=22 Name=ip-permission.cidr,Values=0.0.0.0/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=22 Name=ip-permission.to-port,Values=22 Name=ip-permission.ipv6-cidr,Values=::/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Verify**: both return no rows. Open SSH is scanned and brute-forced continuously; it is the single most exploited misconfiguration in AWS.
  - **Fix**: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 22 --cidr 0.0.0.0/0` (and `--ipv6-cidr ::/0`). Replace it with SSM Session Manager, which needs no inbound rule at all.

- [ ] **Unrestricted RDP Access** - pass: no security group allows port 3389 from `0.0.0.0/0` or `::/0`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=3389 Name=ip-permission.to-port,Values=3389 Name=ip-permission.cidr,Values=0.0.0.0/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=3389 Name=ip-permission.to-port,Values=3389 Name=ip-permission.ipv6-cidr,Values=::/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Verify**: both return no rows. Exposed RDP is the primary initial-access vector for ransomware operators.
  - **Fix**: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 3389 --cidr 0.0.0.0/0` (and `--ipv6-cidr ::/0`), then use SSM Session Manager or Fleet Manager remote desktop.

- [ ] **Unrestricted MySQL Database Access** - pass: no security group allows port 3306 from `0.0.0.0/0` or `::/0`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=3306 Name=ip-permission.to-port,Values=3306 Name=ip-permission.cidr,Values=0.0.0.0/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=3306 Name=ip-permission.to-port,Values=3306 Name=ip-permission.ipv6-cidr,Values=::/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Verify**: both return no rows. A database reachable from the internet is one credential-stuffing run away from full data disclosure.
  - **Fix**: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 3306 --cidr 0.0.0.0/0` (and `--ipv6-cidr ::/0`), then allow only the application tier's security group as the source: `--source-group <app-sg>`.

- [ ] **Unrestricted PostgreSQL Database Access** - pass: no security group allows port 5432 from `0.0.0.0/0` or `::/0`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=5432 Name=ip-permission.to-port,Values=5432 Name=ip-permission.cidr,Values=0.0.0.0/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=5432 Name=ip-permission.to-port,Values=5432 Name=ip-permission.ipv6-cidr,Values=::/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Verify**: both return no rows.
  - **Fix**: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 5432 --cidr 0.0.0.0/0` (and `--ipv6-cidr ::/0`), then re-add with `--source-group <app-sg>`.

- [ ] **Unrestricted MSSQL Database Access** - pass: no security group allows port 1433 from `0.0.0.0/0` or `::/0`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=1433 Name=ip-permission.to-port,Values=1433 Name=ip-permission.cidr,Values=0.0.0.0/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=1433 Name=ip-permission.to-port,Values=1433 Name=ip-permission.ipv6-cidr,Values=::/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Verify**: both return no rows.
  - **Fix**: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 1433 --cidr 0.0.0.0/0` (and `--ipv6-cidr ::/0`), then re-add with `--source-group <app-sg>`.

- [ ] **Unrestricted MongoDB Access** - pass: no security group allows port 27017 from `0.0.0.0/0` or `::/0`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=27017 Name=ip-permission.to-port,Values=27017 Name=ip-permission.cidr,Values=0.0.0.0/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=27017 Name=ip-permission.to-port,Values=27017 Name=ip-permission.ipv6-cidr,Values=::/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Verify**: both return no rows. Internet-exposed MongoDB has been mass-swept and ransomed repeatedly, including instances that were only briefly open.
  - **Fix**: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 27017 --cidr 0.0.0.0/0` (and `--ipv6-cidr ::/0`), and confirm authentication is enabled on the database itself.

- [ ] **Unrestricted Redis Cache Access** - pass: no security group allows port 6379 from `0.0.0.0/0` or `::/0`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=6379 Name=ip-permission.to-port,Values=6379 Name=ip-permission.cidr,Values=0.0.0.0/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=6379 Name=ip-permission.to-port,Values=6379 Name=ip-permission.ipv6-cidr,Values=::/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Verify**: both return no rows. Redis is unauthenticated by default and its `CONFIG` command can be used to write files to disk - exposure is often direct code execution.
  - **Fix**: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 6379 --cidr 0.0.0.0/0` (and `--ipv6-cidr ::/0`), and enable AUTH plus in-transit encryption on the cache.

- [ ] **Unrestricted SMTP Access** - pass: no security group allows port 25 from `0.0.0.0/0` or `::/0`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=25 Name=ip-permission.to-port,Values=25 Name=ip-permission.cidr,Values=0.0.0.0/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=25 Name=ip-permission.to-port,Values=25 Name=ip-permission.ipv6-cidr,Values=::/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Verify**: both return no rows. An open relay gets your address space blocklisted and your domain used for phishing that appears to come from you.
  - **Fix**: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 25 --cidr 0.0.0.0/0` (and `--ipv6-cidr ::/0`); send mail through SES or a managed provider instead of running a relay.

- [ ] **Unrestricted NetBIOS Access** - pass: no security group allows ports 137-139 from `0.0.0.0/0` or `::/0`
  - **Run**: `for p in 137 138 139; do aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=$p Name=ip-permission.to-port,Values=$p Name=ip-permission.cidr,Values=0.0.0.0/0 --query "SecurityGroups[].[GroupId,GroupName]" --output text; done`
  - **Run**: `for p in 137 138 139; do aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=$p Name=ip-permission.to-port,Values=$p Name=ip-permission.ipv6-cidr,Values=::/0 --query "SecurityGroups[].[GroupId,GroupName]" --output text; done`
  - **Verify**: both return no rows. NetBIOS leaks hostnames, workgroup and session data to anyone who asks, and is a standard reconnaissance target.
  - **Fix**: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port <137-139> --cidr 0.0.0.0/0` (and `--ipv6-cidr ::/0`). NetBIOS should never cross a VPC boundary.

- [ ] **Unrestricted CIFS Access** - pass: no security group allows port 445 from `0.0.0.0/0` or `::/0`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=445 Name=ip-permission.to-port,Values=445 Name=ip-permission.cidr,Values=0.0.0.0/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=445 Name=ip-permission.to-port,Values=445 Name=ip-permission.ipv6-cidr,Values=::/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Verify**: both return no rows. SMB on 445 is the port behind EternalBlue and most self-propagating ransomware.
  - **Fix**: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 445 --cidr 0.0.0.0/0` (and `--ipv6-cidr ::/0`); reach file shares over a VPN or use FSx with private endpoints.

- [ ] **Unrestricted RPC Access** - pass: no security group allows port 135 from `0.0.0.0/0` or `::/0`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=135 Name=ip-permission.to-port,Values=135 Name=ip-permission.cidr,Values=0.0.0.0/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=135 Name=ip-permission.to-port,Values=135 Name=ip-permission.ipv6-cidr,Values=::/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Verify**: both return no rows. The RPC endpoint mapper enumerates the services running on a host, and has a long history of remote code execution flaws.
  - **Fix**: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 135 --cidr 0.0.0.0/0` (and `--ipv6-cidr ::/0`).

- [ ] **Unrestricted Telnet Access** - pass: no security group allows port 23 from `0.0.0.0/0` or `::/0`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=23 Name=ip-permission.to-port,Values=23 Name=ip-permission.cidr,Values=0.0.0.0/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Run**: `aws ec2 describe-security-groups --filters Name=ip-permission.from-port,Values=23 Name=ip-permission.to-port,Values=23 Name=ip-permission.ipv6-cidr,Values=::/0 --query 'SecurityGroups[].[GroupId,GroupName]' --output table`
  - **Verify**: both return no rows. Telnet carries credentials in cleartext and has no place in a current environment at all, open or not.
  - **Fix**: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 23 --cidr 0.0.0.0/0` (and `--ipv6-cidr ::/0`), and disable the telnet daemon on the host.

- [ ] **Unrestricted Outbound Access** - pass: no production security group allows all egress to `0.0.0.0/0`
  - **Run**: `aws ec2 describe-security-groups --query "SecurityGroups[?IpPermissionsEgress[?IpProtocol=='-1' && IpRanges[?CidrIp=='0.0.0.0/0']]].{id:GroupId, name:GroupName}" --output table`
  - **Verify**: no production group allows unrestricted egress. Open egress is what turns a foothold into data exfiltration and command-and-control; it is the default on every new security group, so this needs a deliberate change.
  - **Fix**: `aws ec2 revoke-security-group-egress --group-id <sg> --protocol all --cidr 0.0.0.0/0`, then allow only what the workload needs - usually HTTPS to a prefix list or a VPC endpoint. Use `aws ec2 describe-managed-prefix-lists` for AWS service ranges.

- [ ] **EC2 Security Group Port Range** - pass: no rule opens a contiguous range of ports
  - **Run**: `aws ec2 describe-security-groups --query "SecurityGroups[].{id:GroupId, name:GroupName, ranges:IpPermissions[?FromPort!=ToPort].[FromPort,ToPort]}" --output json`
  - **Verify**: `ranges` is empty for every group. A range such as 0-65535 or 1024-65535 exposes every service that will ever listen on the host, including ones added after the rule was written.
  - **Fix**: revoke the range and re-add individual ports: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port <from>-<to> --cidr <cidr>`, then one `authorize-security-group-ingress` per port actually in use.

---

## Networking (VPC)

- [ ] **Default VPC in Use** - pass: no resources run in a default VPC
  - **Run**: `aws ec2 describe-vpcs --query 'Vpcs[?IsDefault].VpcId' --output text | tr '\t' '\n' | while read v; do echo "$v: $(aws ec2 describe-instances --filters Name=vpc-id,Values=$v --query 'length(Reservations[].Instances[])')"; done`
  - **Verify**: every default VPC reports `0` instances. Default VPCs ship with a public subnet per availability zone, an internet gateway, and a permissive default security group - none of which were chosen by you.
  - **Fix**: migrate workloads into a purpose-built VPC, then `aws ec2 delete-vpc --vpc-id <vpc>`. Prevent recreation with the `Skip default VPC creation` setting when new accounts are provisioned.

- [ ] **VPC Flow Logs Enabled** - pass: every VPC has an active flow log
  - **Run**: `aws ec2 describe-vpcs --query 'Vpcs[].VpcId' --output text | tr '\t' '\n' | while read v; do echo "$v: $(aws ec2 describe-flow-logs --filter Name=resource-id,Values=$v --query "length(FlowLogs[?FlowLogStatus=='ACTIVE'])")"; done`
  - **Verify**: every VPC reports at least `1`. Without flow logs there is no record of what talked to what, so an intrusion cannot be scoped after the fact.
  - **Fix**: `aws ec2 create-flow-logs --resource-type VPC --resource-ids <vpc> --traffic-type ALL --log-destination-type cloud-watch-logs --log-group-name <group> --deliver-logs-permission-arn <role-arn>`. Capture `ALL`, not just `REJECT` - accepted traffic is what exfiltration looks like.

- [ ] **Unrestricted Network ACL Inbound Traffic** - pass: no network ACL allows all traffic from `0.0.0.0/0`
  - **Run**: `aws ec2 describe-network-acls --query "NetworkAcls[].{id:NetworkAclId, open:Entries[?!Egress && CidrBlock=='0.0.0.0/0' && RuleAction=='allow' && Protocol=='-1'].RuleNumber}" --output json`
  - **Verify**: `open` is empty for every ACL. Network ACLs are the subnet-level backstop beneath security groups; a blanket allow removes that layer entirely.
  - **Fix**: `aws ec2 delete-network-acl-entry --network-acl-id <acl> --rule-number <n> --ingress`, then add specific allow rules. Keep the deny-all default at the end of the list.

- [ ] **Unrestricted Inbound Traffic on Remote Server Administration Ports** - pass: no network ACL allows 22 or 3389 from `0.0.0.0/0`
  - **Run**: `aws ec2 describe-network-acls --query "NetworkAcls[].{id:NetworkAclId, entries:Entries[?!Egress && CidrBlock=='0.0.0.0/0' && RuleAction=='allow'].{rule:RuleNumber, from:PortRange.From, to:PortRange.To}}" --output json`
  - **Verify**: no allow entry whose port range covers 22 or 3389, and no entry with a null `PortRange` (which means all ports).
  - **Fix**: replace the entry with one scoped to your administrative CIDR, or remove it and rely on SSM Session Manager, which needs no inbound access at all.

- [ ] **VPC Endpoint Exposed** - pass: no VPC endpoint policy allows a wildcard principal
  - **Run**: `aws ec2 describe-vpc-endpoints --query 'VpcEndpoints[].{id:VpcEndpointId, service:ServiceName, policy:PolicyDocument}' --output json`
  - **Verify**: no `policy` grants `"Principal": "*"` without a condition restricting it to your account or Organization. A permissive endpoint policy lets principals outside your account reach the service through your network path.
  - **Fix**: `aws ec2 modify-vpc-endpoint --vpc-endpoint-id <id> --policy-document file://policy.json` with a policy conditioned on `aws:PrincipalOrgID`.

- [ ] **VPC Peering Connections To Accounts Outside AWS Organization** - pass: every peer account is in your Organization or documented
  - **Run**: `aws ec2 describe-vpc-peering-connections --query 'VpcPeeringConnections[].{id:VpcPeeringConnectionId, requester:RequesterVpcInfo.OwnerId, accepter:AccepterVpcInfo.OwnerId, status:Status.Code}' --output table` then compare against `aws organizations list-accounts --query 'Accounts[].Id' --output text`
  - **Verify**: every owner ID appears in your Organization or maps to an approved partner. A peering connection is a routed network path, not an API grant - it bypasses most identity controls.
  - **Fix**: `aws ec2 delete-vpc-peering-connection --vpc-peering-connection-id <id>`. Where the connection is needed, narrow the route tables so only the required subnets are reachable.

---

## Audit & Detection (CloudTrail)

- [ ] **CloudTrail Enabled** - pass: at least one multi-region trail is logging
  - **Run**: `aws cloudtrail describe-trails --query 'trailList[].{name:Name, multiRegion:IsMultiRegionTrail, org:IsOrganizationTrail, bucket:S3BucketName}' --output table` then `aws cloudtrail get-trail-status --name <trail> --query 'IsLogging'`
  - **Verify**: a trail with `multiRegion` = `True` exists and `IsLogging` is `true`. A single-region trail means activity in every other region is unrecorded, which is exactly where an attacker will operate.
  - **Fix**: `aws cloudtrail create-trail --name org-trail --s3-bucket-name <bucket> --is-multi-region-trail --is-organization-trail` then `aws cloudtrail start-logging --name org-trail`.

- [ ] **CloudTrail Global Services Enabled** - pass: `IncludeGlobalServiceEvents` = `true`
  - **Run**: `aws cloudtrail describe-trails --query 'trailList[].{name:Name, global:IncludeGlobalServiceEvents}' --output table`
  - **Verify**: `true` on your primary trail. Global service events cover IAM, STS and CloudFront - the control plane an attacker uses to establish persistence.
  - **Fix**: `aws cloudtrail update-trail --name <trail> --include-global-service-events`

- [ ] **CloudTrail Log File Integrity Validation** - pass: `LogFileValidationEnabled` = `true`
  - **Run**: `aws cloudtrail describe-trails --query 'trailList[].{name:Name, validation:LogFileValidationEnabled}' --output table`
  - **Verify**: `true` on every trail. Without it you cannot prove logs were not altered after the fact, which undermines the evidence in exactly the incident where it matters.
  - **Fix**: `aws cloudtrail update-trail --name <trail> --enable-log-file-validation`, then verify with `aws cloudtrail validate-logs --trail-arn <arn> --start-time <time>`.

- [ ] **CloudTrail Integrated With CloudWatch** - pass: `CloudWatchLogsLogGroupArn` is set and delivery is recent
  - **Run**: `aws cloudtrail describe-trails --query 'trailList[].{name:Name, logGroup:CloudWatchLogsLogGroupArn}' --output table` then `aws cloudtrail get-trail-status --name <trail> --query '{lastDelivery:LatestCloudWatchLogsDeliveryTime, error:LatestCloudWatchLogsDeliveryError}'`
  - **Verify**: `logGroup` is populated, `lastDelivery` is recent, and `error` is null. Without CloudWatch integration there is nothing for metric filters to match, so none of the alarm controls in this guide can function.
  - **Fix**: `aws cloudtrail update-trail --name <trail> --cloud-watch-logs-log-group-arn <arn> --cloud-watch-logs-role-arn <role-arn>`

- [ ] **CloudTrail Management Events** - pass: management events are recorded for both read and write
  - **Run**: `aws cloudtrail get-event-selectors --trail-name <trail> --query '{selectors:EventSelectors, advanced:AdvancedEventSelectors}' --output json`
  - **Verify**: a selector with `IncludeManagementEvents` = `true` and `ReadWriteType` = `All`. `WriteOnly` omits the reconnaissance phase - the `Describe`, `List` and `Get` calls that show what an attacker looked at before acting.
  - **Fix**: `aws cloudtrail put-event-selectors --trail-name <trail> --event-selectors '[{"ReadWriteType":"All","IncludeManagementEvents":true}]'`

---

## Databases (RDS)

- [ ] **RDS Publicly Accessible** - pass: `PubliclyAccessible` = `false` on every instance
  - **Run**: `aws rds describe-db-instances --query 'DBInstances[].{id:DBInstanceIdentifier, public:PubliclyAccessible, endpoint:Endpoint.Address}' --output table`
  - **Verify**: `public` is `False` everywhere. When true, the instance gets a publicly resolvable endpoint and is reachable from the internet subject only to its security group - one permissive rule from full exposure.
  - **Fix**: `aws rds modify-db-instance --db-instance-identifier <id> --no-publicly-accessible --apply-immediately`. Reach the database from the application VPC, or through a bastion or VPN for human access.

- [ ] **RDS Instance Not In Public Subnet** - pass: every DB subnet group contains only private subnets
  - **Run**: `aws rds describe-db-instances --query 'DBInstances[].{id:DBInstanceIdentifier, subnets:DBSubnetGroup.Subnets[].SubnetIdentifier}' --output json`
  - **Verify**: for each subnet listed, `aws ec2 describe-route-tables --filters Name=association.subnet-id,Values=<subnet> --query 'RouteTables[].Routes[?GatewayId!=null].GatewayId'` returns no `igw-` entry. A private subnet is the layer that holds when `PubliclyAccessible` is flipped by mistake.
  - **Fix**: create a subnet group from private subnets with `aws rds create-db-subnet-group`, then move the instance with `aws rds modify-db-instance --db-instance-identifier <id> --db-subnet-group-name <group>`.

- [ ] **Amazon RDS Public Snapshots** - pass: no manual snapshot is shared with `all`
  - **Run**: `aws rds describe-db-snapshots --snapshot-type manual --query 'DBSnapshots[].DBSnapshotIdentifier' --output text | tr '\t' '\n' | while read s; do a=$(aws rds describe-db-snapshot-attributes --db-snapshot-identifier "$s" --query "DBSnapshotAttributesResult.DBSnapshotAttributes[?AttributeName=='restore'].AttributeValues" --output text); echo "$s: ${a:-none}"; done`
  - **Verify**: no snapshot lists `all`. A public snapshot can be restored by anyone into their own account - it is a full copy of your database, and the exposure is silent.
  - **Fix**: `aws rds modify-db-snapshot-attribute --db-snapshot-identifier <snapshot> --attribute-name restore --values-to-remove all`. Treat prior exposure as a data breach and rotate every credential the database held.

- [ ] **IAM Database Authentication** - pass: `IAMDatabaseAuthenticationEnabled` = `true` on MySQL and PostgreSQL instances
  - **Run**: `aws rds describe-db-instances --query "DBInstances[?Engine=='mysql' || Engine=='postgres'].{id:DBInstanceIdentifier, iamAuth:IAMDatabaseAuthenticationEnabled}" --output table`
  - **Verify**: `iamAuth` is `True`. Otherwise access depends on database passwords that are shared, rarely rotated, and invisible to your IAM offboarding process.
  - **Fix**: `aws rds modify-db-instance --db-instance-identifier <id> --enable-iam-database-authentication --apply-immediately`, then grant the `rds-db:connect` action to the relevant roles and drop the password users.

- [ ] **Unrestricted DB Security Group** - pass: no DB security group allows `0.0.0.0/0`
  - **Run**: `aws rds describe-db-instances --query 'DBInstances[].{id:DBInstanceIdentifier, sgs:VpcSecurityGroups[].VpcSecurityGroupId}' --output json` then for each group `aws ec2 describe-security-groups --group-ids <sg> --query "SecurityGroups[].IpPermissions[?IpRanges[?CidrIp=='0.0.0.0/0']]"`
  - **Verify**: no rule with `0.0.0.0/0` on any group attached to a database. (EC2-Classic `describe-db-security-groups` no longer applies to VPC instances - the VPC security group is the control.)
  - **Fix**: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port <db-port> --cidr 0.0.0.0/0` and re-add with `--source-group <app-sg>` so only the application tier can connect.

- [ ] **RDS Auto Minor Version Upgrade** - pass: `AutoMinorVersionUpgrade` = `true`
  - **Run**: `aws rds describe-db-instances --query 'DBInstances[].{id:DBInstanceIdentifier, autoUpgrade:AutoMinorVersionUpgrade, version:EngineVersion}' --output table`
  - **Verify**: `autoUpgrade` is `True` on every instance. Minor versions are where database CVE fixes ship; without this the instance stays vulnerable until someone schedules a manual upgrade.
  - **Fix**: `aws rds modify-db-instance --db-instance-identifier <id> --auto-minor-version-upgrade --apply-immediately`, and set a maintenance window you can tolerate.

- [ ] **RDS Master Username** - pass: no instance uses a default master username
  - **Run**: `aws rds describe-db-instances --query 'DBInstances[].{id:DBInstanceIdentifier, master:MasterUsername}' --output table`
  - **Verify**: no instance uses `admin`, `root`, `postgres`, `sa` or `awsuser`. A predictable username halves the work of a credential-stuffing attempt.
  - **Fix**: the master username cannot be changed in place. Create a new non-default administrative user, migrate applications to it, and restrict the original. For new instances set `--master-username` to something unguessable.

---

## Serverless (Lambda)

- [ ] **Function Exposed** - pass: no resource policy allows a wildcard principal without a source condition
  - **Run**: `aws lambda list-functions --query 'Functions[].FunctionName' --output text | tr '\t' '\n' | while read f; do p=$(aws lambda get-policy --function-name "$f" --query Policy --output text 2>/dev/null); echo "$p" | grep -q '"\*"' && echo "wildcard principal: $f"; done`
  - **Verify**: no output, or every wildcard is paired with a `Condition` on `AWS:SourceArn` or `AWS:SourceAccount`. An unconditioned wildcard lets any AWS principal invoke the function.
  - **Fix**: `aws lambda remove-permission --function-name <fn> --statement-id <sid>`, then re-add scoped: `aws lambda add-permission --function-name <fn> --statement-id <sid> --action lambda:InvokeFunction --principal <service> --source-arn <arn>`.

- [ ] **Lambda Function With Admin Privileges** - pass: no execution role holds AdministratorAccess or a wildcard policy
  - **Run**: `aws lambda list-functions --query 'Functions[].{fn:FunctionName, role:Role}' --output text | while read fn role; do r=${role##*/}; p=$(aws iam list-attached-role-policies --role-name "$r" --query "AttachedPolicies[?PolicyName=='AdministratorAccess'].PolicyName" --output text); [ -n "$p" ] && echo "$fn ($r)"; done`
  - **Verify**: no output. A function's role is available to any code in that function, including a compromised dependency - admin on the role is admin for the whole supply chain.
  - **Fix**: `aws iam detach-role-policy --role-name <role> --policy-arn arn:aws:iam::aws:policy/AdministratorAccess` and replace with a policy covering only the APIs the handler calls. Derive it from CloudTrail with IAM Access Analyzer policy generation.

- [ ] **Lambda Functions Should not Share Roles that Contain Admin Privileges** - pass: no execution role is shared across functions
  - **Run**: `aws lambda list-functions --query 'Functions[].Role' --output text | tr '\t' '\n' | sort | uniq -c | sort -rn | awk '$1 > 1'`
  - **Verify**: no output. A shared role means the least-trusted function determines the blast radius of every function sharing it, and least privilege becomes impossible to express.
  - **Fix**: create one role per function with `aws iam create-role`, then `aws lambda update-function-configuration --function-name <fn> --role <new-role-arn>`.

- [ ] **Lambda Cross Account Access** - pass: every external account in a function policy is known and approved
  - **Run**: `aws lambda list-functions --query 'Functions[].FunctionName' --output text | tr '\t' '\n' | while read f; do p=$(aws lambda get-policy --function-name "$f" --query Policy --output text 2>/dev/null); [ -n "$p" ] && echo "$p" | grep -oE '[0-9]{12}' | sort -u | sed "s|^|$f: |"; done`
  - **Verify**: every account ID is your own or a documented partner. Cross-account invoke rights persist long after the integration that needed them.
  - **Fix**: `aws lambda remove-permission --function-name <fn> --statement-id <sid>` for each stale grant.

- [ ] **Enable IAM Authentication for Lambda Function URLs** - pass: no function URL uses `AuthType` `NONE`
  - **Run**: `aws lambda list-function-url-configs --function-name <fn> --query 'FunctionUrlConfigs[].{url:FunctionUrl, auth:AuthType}' --output table` - or sweep all: `aws lambda list-functions --query 'Functions[].FunctionName' --output text | tr '\t' '\n' | while read f; do aws lambda list-function-url-configs --function-name "$f" --query "FunctionUrlConfigs[].{fn:'$f', auth:AuthType}" --output text 2>/dev/null; done`
  - **Verify**: no configuration shows `NONE`. `AuthType: NONE` publishes an unauthenticated HTTPS endpoint straight to the internet, with no WAF and no API Gateway in front of it.
  - **Fix**: `aws lambda update-function-url-config --function-name <fn> --auth-type AWS_IAM`, or delete the URL with `aws lambda delete-function-url-config` and route through API Gateway where you can attach a WAF and throttling.

- [ ] **Lambda Using Supported Runtime Environment** - pass: no function runs a deprecated runtime
  - **Run**: `aws lambda list-functions --query 'Functions[].{fn:FunctionName, runtime:Runtime}' --output table | sort -k2`
  - **Verify**: every runtime is on the current AWS supported list. A deprecated runtime stops receiving security patches, and AWS eventually blocks updates to the function entirely.
  - **Fix**: upgrade the code and redeploy with `aws lambda update-function-configuration --function-name <fn> --runtime <supported-runtime>`. Test first - runtime upgrades carry breaking language changes.

- [ ] **VPC Access for AWS Lambda Functions** - pass: functions reaching private resources have a `VpcConfig`
  - **Run**: `aws lambda list-functions --query 'Functions[].{fn:FunctionName, vpc:VpcConfig.VpcId, subnets:length(VpcConfig.SubnetIds || [])}' --output table`
  - **Verify**: every function that touches a database, cache or internal service has a `vpc` set. A function outside a VPC reaches those resources only if they are publicly exposed - so a null here often means something else is open.
  - **Fix**: `aws lambda update-function-configuration --function-name <fn> --vpc-config SubnetIds=<subnet-ids>,SecurityGroupIds=<sg-ids>` using private subnets, and add VPC endpoints for the AWS services the function calls.

---

## Encryption Keys (KMS)

- [ ] **Key Exposed** - pass: no key policy allows a wildcard principal without a condition
  - **Run**: `aws kms list-keys --query 'Keys[].KeyId' --output text | tr '\t' '\n' | while read k; do m=$(aws kms describe-key --key-id "$k" --query 'KeyMetadata.KeyManager' --output text); [ "$m" = "CUSTOMER" ] || continue; aws kms get-key-policy --key-id "$k" --policy-name default --query Policy --output text | grep -q '"AWS": "\*"' && echo "wildcard: $k"; done`
  - **Verify**: no output, or every wildcard principal is constrained by a `Condition` on `kms:CallerAccount` or `aws:PrincipalOrgID`. An open key policy makes the encryption decorative - anyone who can reach the ciphertext can also call `Decrypt`.
  - **Fix**: `aws kms put-key-policy --key-id <key> --policy-name default --policy file://policy.json` naming only the roles that need `Encrypt`, `Decrypt` or `GenerateDataKey`.

- [ ] **KMS Cross Account Access** - pass: every external account in a key policy is known and approved
  - **Run**: `aws kms list-keys --query 'Keys[].KeyId' --output text | tr '\t' '\n' | while read k; do aws kms get-key-policy --key-id "$k" --policy-name default --query Policy --output text 2>/dev/null | grep -oE 'arn:aws:iam::[0-9]{12}' | sort -u | sed "s|^|$k: |"; done`
  - **Verify**: every account ID is your own or a documented partner. Cross-account decrypt rights are equivalent to handing over the data the key protects.
  - **Fix**: remove the principal from the key policy. Also check grants, which do not appear in the policy: `aws kms list-grants --key-id <key>`, then `aws kms revoke-grant --key-id <key> --grant-id <id>`.

---

## Kubernetes (EKS)

- [ ] **EKS Cluster Endpoint Public Access** - pass: `endpointPublicAccess` = `false`, or restricted by CIDR
  - **Run**: `aws eks list-clusters --query 'clusters' --output text | tr '\t' '\n' | while read c; do aws eks describe-cluster --name "$c" --query "cluster.{name:name, public:resourcesVpcConfig.endpointPublicAccess, private:resourcesVpcConfig.endpointPrivateAccess, cidrs:resourcesVpcConfig.publicAccessCidrs}" --output json; done`
  - **Verify**: `public` is `false`, or `true` with `cidrs` containing no `0.0.0.0/0`. A public API server with the default CIDR accepts authentication attempts from anywhere.
  - **Fix**: `aws eks update-cluster-config --name <cluster> --resources-vpc-config endpointPublicAccess=false,endpointPrivateAccess=true`, or restrict with `publicAccessCidrs=<office>,<vpn>,<ci-egress>/32`.

- [ ] **Ensure EKS Clusters Have Private Endpoint Enabled and Public Access Disabled** - pass: `endpointPrivateAccess` = `true` and `endpointPublicAccess` = `false`
  - **Run**: `aws eks list-clusters --query 'clusters' --output text | tr '\t' '\n' | while read c; do echo "$c: $(aws eks describe-cluster --name "$c" --query 'resourcesVpcConfig.[endpointPrivateAccess,endpointPublicAccess]' --output text)"; done`
  - **Verify**: `True False` for every production cluster. Private-only access means the API server is reachable solely from inside the VPC or over a connected network.
  - **Fix**: `aws eks update-cluster-config --name <cluster> --resources-vpc-config endpointPrivateAccess=true,endpointPublicAccess=false`. Confirm your CI has a network path first, or deployments will break.

- [ ] **Ensure EKS Clusters Are Created with Private Nodes** - pass: node group subnets have no route to an internet gateway
  - **Run**: `aws eks list-clusters --query 'clusters' --output text | tr '\t' '\n' | while read c; do for g in $(aws eks list-nodegroups --cluster-name "$c" --query 'nodegroups' --output text); do echo "== $c/$g"; aws eks describe-nodegroup --cluster-name "$c" --nodegroup-name "$g" --query 'nodegroup.subnets' --output text; done; done`
  - **Verify**: each subnet's route table has no `0.0.0.0/0` route to an `igw-` - check with `aws ec2 describe-route-tables --filters Name=association.subnet-id,Values=<subnet>`. Nodes with public addresses expose the kubelet and every hostNetwork pod.
  - **Fix**: recreate the node group in private subnets with `aws eks create-nodegroup --subnets <private-subnets>`, give it a NAT gateway for egress, then drain and delete the old one.

- [ ] **Disable Remote Access to EKS Cluster Node Groups** - pass: no node group has a `remoteAccess` SSH key configured
  - **Run**: `aws eks list-clusters --query 'clusters' --output text | tr '\t' '\n' | while read c; do for g in $(aws eks list-nodegroups --cluster-name "$c" --query 'nodegroups' --output text); do echo "$c/$g: $(aws eks describe-nodegroup --cluster-name "$c" --nodegroup-name "$g" --query 'nodegroup.remoteAccess' --output json | tr -d '\n')"; done; done`
  - **Verify**: `remoteAccess` is `null` for every node group. A configured SSH key is a standing path onto the node that bypasses Kubernetes authorization entirely.
  - **Fix**: node group remote access cannot be removed in place - recreate the node group without `--remote-access`, then use SSM Session Manager for the rare cases where node access is genuinely needed.

- [ ] **Enable Envelope Encryption for EKS Kubernetes Secrets** - pass: an `encryptionConfig` with a KMS key covering `secrets`
  - **Run**: `aws eks list-clusters --query 'clusters' --output text | tr '\t' '\n' | while read c; do echo "$c: $(aws eks describe-cluster --name "$c" --query 'cluster.encryptionConfig' --output json | tr -d '\n')"; done`
  - **Verify**: each cluster returns a config with `resources: ["secrets"]` and a customer-managed KMS key ARN. Without it, Kubernetes secrets sit in etcd protected only by platform keys you cannot rotate or revoke.
  - **Fix**: `aws eks associate-encryption-config --cluster-name <cluster> --encryption-config '[{"resources":["secrets"],"provider":{"keyArn":"<kms-key-arn>"}}]'`. This is one-way - it cannot be removed afterwards.

- [ ] **Enable Support for Network Policies** - pass: a network policy engine is installed and default-deny policies exist
  - **Run**: `aws eks list-clusters --query 'clusters' --output text | tr '\t' '\n' | while read c; do echo "== $c"; aws eks list-addons --cluster-name "$c" --query 'addons' --output text; done` then, against the cluster, `kubectl get networkpolicy --all-namespaces`
  - **Verify**: the VPC CNI addon has network policy enabled (or Calico/Cilium is installed) **and** each namespace has a default-deny policy. An engine with no policies enforces nothing - every pod still reaches every other pod.
  - **Fix**: `aws eks update-addon --cluster-name <cluster> --addon-name vpc-cni --configuration-values '{"enableNetworkPolicy":"true"}'`, then apply a default-deny `NetworkPolicy` per namespace and allow-list the flows you need.

- [ ] **Kubernetes Cluster Logging** - pass: all five control plane log types are enabled
  - **Run**: `aws eks list-clusters --query 'clusters' --output text | tr '\t' '\n' | while read c; do echo "$c: $(aws eks describe-cluster --name "$c" --query 'cluster.logging.clusterLogging' --output json | tr -d '\n')"; done`
  - **Verify**: `api`, `audit`, `authenticator`, `controllerManager` and `scheduler` all appear with `enabled: true`. The `audit` log in particular is the only record of who called the Kubernetes API.
  - **Fix**: `aws eks update-cluster-config --name <cluster> --logging '{"clusterLogging":[{"types":["api","audit","authenticator","controllerManager","scheduler"],"enabled":true}]}'`

- [ ] **Kubernetes Cluster Version** - pass: every cluster runs a version still in standard support
  - **Run**: `aws eks list-clusters --query 'clusters' --output text | tr '\t' '\n' | while read c; do echo "$c: $(aws eks describe-cluster --name "$c" --query 'cluster.version' --output text)"; done`
  - **Verify**: each version is within the AWS standard support window. Extended support costs more and ends; past that, the control plane stops receiving security patches.
  - **Fix**: `aws eks update-cluster-version --name <cluster> --kubernetes-version <version>`, one minor version at a time, then update node groups and addons to match.

- [ ] **Use OIDC Provider for Authenticating Kubernetes API Calls** - pass: an IAM OIDC provider exists for the cluster issuer
  - **Run**: `aws eks list-clusters --query 'clusters' --output text | tr '\t' '\n' | while read c; do iss=$(aws eks describe-cluster --name "$c" --query 'cluster.identity.oidc.issuer' --output text); echo "$c: $iss"; done` then `aws iam list-open-id-connect-providers`
  - **Verify**: each cluster's issuer URL has a matching IAM OIDC provider. Without it, pods cannot use IAM roles for service accounts and fall back to the node instance role - every pod on the node inherits the same permissions.
  - **Fix**: `eksctl utils associate-iam-oidc-provider --cluster <cluster> --approve`, or create it with `aws iam create-open-id-connect-provider --url <issuer> --client-id-list sts.amazonaws.com`, then move workloads to IRSA or EKS Pod Identity.

---

## Secrets Management

- [ ] **AWS Secrets Manager in Use for RDS Instances** - pass: every RDS master credential is stored in Secrets Manager
  - **Run**: `aws secretsmanager list-secrets --query 'SecretList[].{name:Name, rotation:RotationEnabled, lastRotated:LastRotatedDate}' --output table` then `aws rds describe-db-instances --query 'DBInstances[].{id:DBInstanceIdentifier, managedSecret:MasterUserSecret.SecretArn}' --output table`
  - **Verify**: every database has a corresponding secret - either a managed `MasterUserSecret` or a documented Secrets Manager entry. Credentials outside it usually live in application config, CI variables or a shared password manager where rotation never happens.
  - **Fix**: `aws rds modify-db-instance --db-instance-identifier <id> --manage-master-user-password --apply-immediately` to hand the master password to Secrets Manager, and grant the application role `secretsmanager:GetSecretValue` on that secret only.

- [ ] **Secret Rotation Enabled** - pass: `RotationEnabled` = `true` on every secret
  - **Run**: `aws secretsmanager list-secrets --query "SecretList[?!RotationEnabled].{name:Name, created:CreatedDate}" --output table`
  - **Verify**: no rows. A secret that never rotates has the same value it had the day someone copied it into a notebook, and a leak stays exploitable indefinitely.
  - **Fix**: `aws secretsmanager rotate-secret --secret-id <secret> --rotation-lambda-arn <arn> --rotation-rules AutomaticallyAfterDays=30`. For RDS managed secrets, rotation is configured with `--manage-master-user-password` and handled by AWS.
