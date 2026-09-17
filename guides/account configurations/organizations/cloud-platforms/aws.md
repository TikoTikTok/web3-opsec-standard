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

Each item states its **pass** condition, then gives **Console** (the AWS Management Console) and **CLI** (the AWS CLI) steps to **Verify** and **Fix** it. Under CLI, **Expect** is the output that means it passes. Pick the channel you work in at the top of the guide; an item shows only the channels that can check or change the setting, and it passes only when every resource the command returns meets the condition.

#### Prerequisites

- AWS CLI v2 - check with `aws --version`.
- Confirm which account you are auditing: `aws sts get-caller-identity`
- A read-only principal is enough for every **Verify** command. Attach the AWS-managed `SecurityAudit` and `ViewOnlyAccess` policies.
- **Most checks are regional.** IAM, S3 bucket listing, Organizations and account-level settings are global; everything else must be repeated per region. To sweep every enabled region:
  - `for r in $(aws ec2 describe-regions --query 'Regions[].RegionName' --output text); do echo "== $r"; AWS_REGION=$r <command>; done`
- Several IAM checks read the credential report. Generate it once before you start - the first call returns `STARTED`, so run it twice:
  - `aws iam generate-credential-report`
- In a multi-account Organization, run the whole guide in each member account. Organization-wide controls (SCPs, the Organization CloudTrail, the Access Analyzer) are checked from the management account.

---

## Identity & Access (IAM)

#### Root Account

- [ ] **Root Account Access Keys Present** - pass: `AccountAccessKeysPresent` = `0`
  - **Console**:
    - Verify: IAM > Dashboard > Security recommendations > `Root user has no active access keys` shows a green check mark
    - Fix: IAM (signed in as the root user) > My security credentials > Access keys > select each key > Actions > Delete > type the key ID > Delete
  - **CLI**:
    - Verify: `aws iam get-account-summary --query 'SummaryMap.AccountAccessKeysPresent'`
    - Expect: `0`. Any other value means the root user has a long-lived access key, which cannot be scoped, restricted by policy or denied by an SCP - one leak is unlimited access to the account.

- [ ] **Root MFA Enabled** - pass: `AccountMFAEnabled` = `1`
  - **Console**:
    - Verify: IAM > Dashboard > Security recommendations > `Root user has MFA` shows a green check mark
    - Fix: IAM (signed in as the root user) > My security credentials > Multi-factor authentication (MFA) > Assign MFA device > choose `Passkey or security key` or `Hardware TOTP token` > Next > complete the registration > Add MFA
  - **CLI**:
    - Verify: `aws iam get-account-summary --query 'SummaryMap.AccountMFAEnabled'`
    - Expect: `1`. Without MFA the root password alone controls the account, including billing and account closure.

- [ ] **Root Account Credentials Usage** - pass: no root sign-in since the last recorded break-glass event
  - **Console**:
    - Verify: IAM > Credential report > Download report > open the CSV > the `<root_account>` row > `password_last_used` reads `no_information` or a date you can tie to a specific approved task
    - Fix: CloudWatch > Logs > Log groups > <cloudtrail-log-group> > Metric filters > Create metric filter > Filter pattern `{ $.userIdentity.type = "Root" && $.userIdentity.invokedBy NOT EXISTS && $.eventType != "AwsServiceEvent" }` > Next > Filter name `RootUsage`, Metric namespace `CISBenchmark`, Metric name `RootUsage`, Metric value `1` > Next > Create metric filter; then select the filter > Create alarm > Threshold `Greater/Equal` than `1` > Next > Notification > an on-call SNS topic > Next > Alarm name `RootUsage` > Create alarm
  - **CLI**:
    - Verify:
      ```bash
      aws iam get-credential-report --query Content --output text | base64 --decode | \
        awk -F, 'NR==1 || $1=="<root_account>" {print $1", "$5", "$11", "$16}'
      ```
    - Expect: `password_last_used` is `no_information`, or a date you can tie to a specific approved task (account setup, a support case, an SCP change). An unexplained recent root sign-in is an incident, not a finding.
    - Fix:
      ```bash
      aws logs put-metric-filter --log-group-name <cloudtrail-log-group> --filter-name RootUsage \
        --filter-pattern '{ $.userIdentity.type = "Root" && $.userIdentity.invokedBy NOT EXISTS && $.eventType != "AwsServiceEvent" }' \
        --metric-transformations metricName=RootUsage,metricNamespace=CISBenchmark,metricValue=1
      ```
    - Fix:
      ```bash
      aws cloudwatch put-metric-alarm --alarm-name RootUsage --namespace CISBenchmark --metric-name RootUsage \
        --statistic Sum --period 300 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
        --evaluation-periods 1 --alarm-actions <sns-topic-arn>
      ```

- [ ] **Hardware MFA for AWS Root Account** - pass: `AccountMFAEnabled` = `1` with no virtual MFA device on root
  - **Console**:
    - Verify: IAM (signed in as the root user) > My security credentials > Multi-factor authentication (MFA) > the device list shows a `Security key` or `Hardware TOTP token` entry and no `Virtual` (authenticator app) entry
    - Fix: IAM (signed in as the root user) > My security credentials > Multi-factor authentication (MFA) > Assign MFA device > `Passkey or security key` or `Hardware TOTP token` > Next > register the device > Add MFA; then select the virtual device > Remove > Remove
  - **CLI**:
    - Verify:
      ```bash
      aws iam list-virtual-mfa-devices \
        --query "VirtualMFADevices[?ends_with(User.Arn, ':root')].SerialNumber"
      ```
    - Verify: `aws iam get-account-summary --query 'SummaryMap.AccountMFAEnabled'`
    - Expect: the first command returns an empty list `[]` and the second returns `1`. A serial number means root is protected by a software authenticator on a phone that can be lost, cloned or restored from a backup.

#### Users & Permissions

- [ ] **Enable MFA for IAM Users with Console Password** - pass: the query returns no users
  - **Console**:
    - Verify: IAM > Users > every row whose `Password age` column shows a value also shows a device type in the `MFA` column (no console user reads `-` under MFA)
    - Fix: IAM > Users > <user> > Security credentials > Multi-factor authentication (MFA) > Assign MFA device > choose the device type > Next > register the device > Add MFA; then IAM > Policies > Create policy > JSON > a `Deny` on `*` with condition `"BoolIfExists": {"aws:MultiFactorAuthPresent": "false"}` > Next > Create policy > attach it to every console user's group
  - **CLI**:
    - Verify:
      ```bash
      aws iam get-credential-report --query Content --output text | base64 --decode | \
        awk -F, 'NR>1 && $4=="true" && $8=="false" {print $1}'
      ```
    - Expect: no output. Every name printed is a user who can sign in to the console with a password alone.
    - Fix:
      ```bash
      aws iam enable-mfa-device --user-name <user> --serial-number <mfa-arn> \
        --authentication-code1 <code1> --authentication-code2 <code2>
      ```

- [ ] **IAM Users with Administrative Privileges** - pass: no IAM user holds AdministratorAccess except named break-glass accounts
  - **Console**:
    - Verify: IAM > Policies > AdministratorAccess > Entities attached > the `Users` list and the `Groups` list contain only documented break-glass users and no group that ordinary users belong to
    - Fix: IAM > Policies > AdministratorAccess > Entities attached > select the user or group > Detach > Detach; then IAM > Users > <user> > Permissions > Add permissions > Attach policies directly > the narrowest managed policy that works > Add permissions
  - **CLI**:
    - Verify:
      ```bash
      aws iam list-users --query 'Users[].UserName' --output text | tr '\t' '\n' | while read u; do
        p=$(aws iam list-attached-user-policies --user-name "$u" \
          --query "AttachedPolicies[?PolicyName=='AdministratorAccess'].PolicyName" --output text)
        [ -n "$p" ] && echo "direct: $u"
      done
      ```
    - Verify: `aws iam list-groups-for-user --user-name <user> --query 'Groups[].GroupName' --output text`
    - Verify: `aws iam list-attached-group-policies --group-name <group> --query 'AttachedPolicies[].PolicyName'`
    - Expect: the loop prints nothing beyond documented break-glass users, and no group a user belongs to carries `AdministratorAccess`. Standing admin on a user is a credential that works from anywhere without an assumed-role MFA step.
    - Fix:
      ```bash
      aws iam detach-user-policy --user-name <user> \
        --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
      ```

- [ ] **IAM Policies With Full Administrative Privileges** - pass: no customer-managed policy allows Action `*` on Resource `*`
  - **Console**:
    - Verify: IAM > Policies > filter `Type: Customer managed` > open each policy > Permissions > JSON > no statement combines `"Effect": "Allow"`, `"Action": "*"` and `"Resource": "*"`
    - Fix: IAM > Policies > <policy> > Permissions > Edit > JSON > replace the wildcard with an explicit action list and resource ARNs > Next > Save changes
  - **CLI**:
    - Verify:
      ```bash
      aws iam list-policies --scope Local --only-attached --query 'Policies[].Arn' --output text | tr '\t' '\n' | while read a; do
        echo "== $a"
        aws iam get-policy-version --policy-arn "$a" \
          --version-id "$(aws iam get-policy --policy-arn "$a" --query Policy.DefaultVersionId --output text)" \
          --query 'PolicyVersion.Document.Statement'
      done
      ```
    - Expect: no statement combines `"Effect": "Allow"` with `"Action": "*"` and `"Resource": "*"`. That combination is `AdministratorAccess` under a custom name, which is how admin survives a review that only looks for the AWS-managed policy.
    - Fix:
      ```bash
      aws iam create-policy-version --policy-arn <arn> --policy-document file://policy.json \
        --set-as-default
      ```

- [ ] **IAM Policies with Effect Allow and NotAction** - pass: no Allow statement uses `NotAction`
  - **Console**:
    - Verify: IAM > Policies > filter `Type: Customer managed` > open each policy > Permissions > JSON > no statement with `"Effect": "Allow"` contains a `NotAction` key
    - Fix: IAM > Policies > <policy> > Permissions > Edit > JSON > replace `NotAction` with an explicit `Action` list > Next > Save changes
  - **CLI**:
    - Verify:
      ```bash
      aws iam list-policies --scope Local --only-attached --query 'Policies[].Arn' --output text | tr '\t' '\n' | while read a; do
        d=$(aws iam get-policy-version --policy-arn "$a" \
          --version-id "$(aws iam get-policy --policy-arn "$a" --query Policy.DefaultVersionId --output text)" \
          --query 'PolicyVersion.Document' --output json)
        echo "$d" | grep -q '"NotAction"' && echo "$a"
      done
      ```
    - Expect: no output. `Allow` with `NotAction` grants everything except what you listed, so every service AWS launches afterwards is permitted by default in a policy nobody revisits.
    - Fix:
      ```bash
      aws iam create-policy-version --policy-arn <arn> --policy-document file://policy.json \
        --set-as-default
      ```

- [ ] **IAM Role Policy Too Permissive** - pass: no role holds AdministratorAccess or a wildcard inline policy
  - **Console**:
    - Verify: IAM > Policies > AdministratorAccess > Entities attached > the `Roles` list contains only documented roles, and IAM > Roles > <role> > Permissions > Permissions policies > no inline policy JSON allows `"Action": "*"` on `"Resource": "*"`
    - Fix: IAM > Roles > <role> > Permissions > Permissions policies > select AdministratorAccess > Remove > Remove; then Add permissions > Attach policies > a policy scoped to the services the workload calls > Add permissions
  - **CLI**:
    - Verify:
      ```bash
      aws iam list-roles --query "Roles[?!starts_with(Path, '/aws-service-role/')].RoleName" --output text | tr '\t' '\n' | while read r; do
        p=$(aws iam list-attached-role-policies --role-name "$r" \
          --query "AttachedPolicies[?PolicyName=='AdministratorAccess'].PolicyName" --output text)
        [ -n "$p" ] && echo "$r"
      done
      ```
    - Verify: `aws iam list-role-policies --role-name <role>`
    - Verify: `aws iam get-role-policy --role-name <role> --policy-name <name>`
    - Expect: the loop prints only roles that genuinely need account-wide control and are documented, and no inline policy allows `*` on `*`. A role attached to compute is a credential any code on that compute can use.
    - Fix:
      ```bash
      aws iam detach-role-policy --role-name <role> \
        --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
      ```

- [ ] **Cross-Account Access Lacks External ID and MFA** - pass: every cross-account trust carries an `sts:ExternalId` or MFA condition
  - **Console**:
    - Verify: IAM > Roles > every row whose `Trusted entities` column reads `Account: <other-account-id>` > open the role > Trust relationships > the policy JSON has a `Condition` block on `sts:ExternalId` or `aws:MultiFactorAuthPresent`
    - Fix: IAM > Roles > <role> > Trust relationships > Edit trust policy > add `"Condition": {"StringEquals": {"sts:ExternalId": "<value agreed with the third party>"}}` (or `"Bool": {"aws:MultiFactorAuthPresent": "true"}` for human access) > Update policy
  - **CLI**:
    - Verify:
      ```bash
      aws iam list-roles \
        --query "Roles[?contains(to_string(AssumeRolePolicyDocument), ':root') || contains(to_string(AssumeRolePolicyDocument), ':user/')].{Role:RoleName, Trust:AssumeRolePolicyDocument}" \
        --output json
      ```
    - Expect: each role trusting a principal in another account has a `Condition` block requiring `sts:ExternalId`, or `aws:MultiFactorAuthPresent` for human access. Without one, any third party who learns your role ARN and account ID can attempt assumption - the confused deputy problem.
    - Fix: `aws iam update-assume-role-policy --role-name <role> --policy-document file://trust.json`

- [ ] **Check for Untrusted Cross-Account IAM Roles** - pass: every external account ID in a trust policy is known and approved
  - **Console**:
    - Verify: IAM > Roles > every `Account: <id>` value in the `Trusted entities` column is your own account, appears under Organizations > AWS accounts, or maps to a named vendor with a current contract
    - Fix: IAM > Roles > <role> > Trust relationships > Edit trust policy > remove the external principal > Update policy; or IAM > Roles > select the role > Delete > type the role name > Delete if nothing else uses it
  - **CLI**:
    - Verify:
      ```bash
      aws iam list-roles --query 'Roles[].{Role:RoleName, Trust:AssumeRolePolicyDocument}' --output json | \
        grep -oE 'arn:aws:iam::[0-9]{12}' | sort -u
      ```
    - Verify: `aws organizations list-accounts --query 'Accounts[].Id' --output text`
    - Expect: every account ID from the first command that is not your own appears in the second command's output or maps to a named vendor with a current contract. Stale vendor trusts are a standing path into the account long after the engagement ends.
    - Fix: `aws iam update-assume-role-policy --role-name <role> --policy-document file://trust.json`
    - Fix: `aws iam delete-role --role-name <role>`

- [ ] **Inactive IAM Console User** - pass: no console user idle for more than 90 days
  - **Console**:
    - Verify: IAM > Users > the `Console last sign-in` column shows no date older than 90 days (and no `Never` on a user with a `Password age` value)
    - Fix: IAM > Users > <user> > Security credentials > Console sign-in > Manage console access > Console access `Disable` > Apply; then IAM > Users > select the user > Delete > type the user name > Delete once nothing depends on it
  - **CLI**:
    - Verify:
      ```bash
      aws iam get-credential-report --query Content --output text | base64 --decode | \
        awk -F, 'NR>1 && $4=="true" {print $1", last used: "$5}'
      ```
    - Expect: every console-enabled user shows a sign-in within 90 days. Dormant accounts keep their permissions, are rarely covered by MFA reviews, and are the quietest way back into an account after offboarding.
    - Fix: `aws iam delete-login-profile --user-name <user>`

- [ ] **Unused IAM User** - pass: no user without console or access-key activity in 90 days
  - **Console**:
    - Verify: IAM > Users > the `Last activity` column shows no `None` and no date older than 90 days
    - Fix: IAM > Users > select the user > Delete > type the user name > Delete (the console detaches policies and removes keys in the same flow)
  - **CLI**:
    - Verify:
      ```bash
      aws iam get-credential-report --query Content --output text | base64 --decode | \
        awk -F, 'NR>1 {print $1", password: "$5", key1: "$11", key2: "$16}'
      ```
    - Expect: every user shows activity within 90 days on at least one credential. A user with `N/A` across all three has never been used and should not exist.
    - Fix: `aws iam delete-access-key --user-name <user> --access-key-id <id>`
    - Fix: `aws iam delete-user --user-name <user>`

- [ ] **IAM User with Password and Access Keys** - pass: no user has both a console password and an active access key
  - **Console**:
    - Verify: IAM > Users > no row shows a value in both the `Password age` column and the `Active key age` column
    - Fix: IAM > Users > <user> > Security credentials > Access keys > Actions > Deactivate > Deactivate, then Actions > Delete > type the key ID > Delete (for a person); or Security credentials > Console sign-in > Manage console access > Console access `Disable` > Apply (for a workload)
  - **CLI**:
    - Verify:
      ```bash
      aws iam get-credential-report --query Content --output text | base64 --decode | \
        awk -F, 'NR>1 && $4=="true" && ($9=="true" || $14=="true") {print $1}'
      ```
    - Expect: no output. A human identity with programmatic keys doubles the credential surface and means a key leak cannot be distinguished from normal human activity in CloudTrail.
    - Fix: `aws iam delete-access-key --user-name <user> --access-key-id <id>`
    - Fix: `aws iam delete-login-profile --user-name <user>`

- [ ] **Unnecessary Access Keys** - pass: no active access key that has never been used
  - **Console**:
    - Verify: IAM > Users > <user> > Security credentials > Access keys > every key with `Status` = `Active` shows a `Last used` value other than `Never`
    - Fix: IAM > Users > <user> > Security credentials > Access keys > select the key > Actions > Deactivate > Deactivate; after a soak period Actions > Delete > type the key ID > Delete
  - **CLI**:
    - Verify:
      ```bash
      aws iam get-credential-report --query Content --output text | base64 --decode | \
        awk -F, 'NR>1 && (($9=="true" && $11=="N/A") || ($14=="true" && $16=="N/A")) {print $1}'
      ```
    - Expect: no output. An active key that has never been used is a live credential nobody is watching, and its absence from logs means a compromise produces no anomaly.
    - Fix: `aws iam update-access-key --user-name <user> --access-key-id <id> --status Inactive`
    - Fix: `aws iam delete-access-key --user-name <user> --access-key-id <id>`

- [ ] **Access Keys Rotated 90 Days** - pass: no active access key older than 90 days
  - **Console**:
    - Verify: IAM > Users > the `Active key age` column shows no value above 90 days
    - Fix: IAM > Users > <user> > Security credentials > Access keys > Create access key > deploy the new key to every consumer; then select the old key > Actions > Deactivate > Deactivate > Actions > Delete > type the key ID > Delete
  - **CLI**:
    - Verify:
      ```bash
      aws iam list-users --query 'Users[].UserName' --output text | tr '\t' '\n' | while read u; do
        aws iam list-access-keys --user-name "$u" \
          --query "AccessKeyMetadata[?Status=='Active'].[UserName,AccessKeyId,CreateDate]" --output text
      done
      ```
    - Expect: every `CreateDate` is within 90 days. The longer a key lives, the more places it has been copied to - CI config, a laptop, a shared note.
    - Fix: `aws iam create-access-key --user-name <user>`
    - Fix: `aws iam update-access-key --user-name <user> --access-key-id <old-id> --status Inactive`
    - Fix: `aws iam delete-access-key --user-name <user> --access-key-id <old-id>`

- [ ] **IAM Access Analyzer in Use** - pass: an `ACTIVE` analyzer exists in every region in use
  - **Console**:
    - Verify: IAM > Access Analyzer > Analyzer settings > an analyzer with `Status` = `Active` and `Zone of trust` = `Organization` (or `Account`) is listed in every region in use
    - Fix: IAM > Access Analyzer > Analyzer settings > Create analyzer > Findings type `External access analysis` > Zone of trust `Current organization` > Create analyzer; repeat in every region in use
  - **CLI**:
    - Verify:
      ```bash
      aws accessanalyzer list-analyzers \
        --query "analyzers[?status=='ACTIVE'].{name:name, type:type}" --output table
      ```
    - Expect: at least one row, with `type` = `ORGANIZATION` if you use AWS Organizations. Access Analyzer is what tells you a bucket, role, key or secret has become reachable from outside your trust zone.
    - Fix: `aws accessanalyzer create-analyzer --analyzer-name org-analyzer --type ORGANIZATION`

- [ ] **MFA Device Deactivated** - pass: no unexplained `DeactivateMFADevice` event, and an alarm covers it
  - **Console**:
    - Verify: CloudTrail > Event history > Lookup attributes `Event name` = `DeactivateMFADevice` > every event maps to a known device replacement, and CloudWatch > Alarms > All alarms > an alarm on the metric of the `DeactivateMFADevice` metric filter shows `Actions` = `Actions enabled` with an SNS topic
    - Fix: IAM > Users > <user> > Security credentials > Multi-factor authentication (MFA) > Assign MFA device > re-register the device > Add MFA; then CloudWatch > Logs > Log groups > <cloudtrail-log-group> > Metric filters > Create metric filter > Filter pattern `{ ($.eventName = "DeactivateMFADevice") || ($.eventName = "DeleteVirtualMFADevice") }` > Next > Filter name `MFADeactivated`, Metric namespace `CISBenchmark`, Metric name `MFADeactivated`, Metric value `1` > Next > Create metric filter > select the filter > Create alarm > Threshold `Greater/Equal` than `1` > Next > Notification > an on-call SNS topic > Next > Alarm name `MFADeactivated` > Create alarm
  - **CLI**:
    - Verify:
      ```bash
      aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=DeactivateMFADevice \
        --max-results 20 --query 'Events[].{Time:EventTime, By:Username}' --output table
      ```
    - Verify:
      ```bash
      aws logs describe-metric-filters --log-group-name <cloudtrail-log-group> \
        --query "metricFilters[?contains(filterPattern, 'DeactivateMFADevice')].{name:filterName, metric:metricTransformations[0].metricName}" \
        --output table
      ```
    - Verify:
      ```bash
      aws cloudwatch describe-alarms \
        --query 'MetricAlarms[].{name:AlarmName, metric:MetricName, actions:AlarmActions}' --output table
      ```
    - Expect: every event maps to a known device replacement, the second command returns a filter, and that filter's `metric` appears in the third command's output with a non-empty `actions` list. Deactivating MFA is a standard step in an account takeover because it is quieter than changing a password.
    - Fix:
      ```bash
      aws logs put-metric-filter --log-group-name <cloudtrail-log-group> --filter-name MFADeactivated \
        --filter-pattern '{ ($.eventName = "DeactivateMFADevice") || ($.eventName = "DeleteVirtualMFADevice") }' \
        --metric-transformations metricName=MFADeactivated,metricNamespace=CISBenchmark,metricValue=1
      ```
    - Fix:
      ```bash
      aws cloudwatch put-metric-alarm --alarm-name MFADeactivated --namespace CISBenchmark --metric-name MFADeactivated \
        --statistic Sum --period 300 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
        --evaluation-periods 1 --alarm-actions <sns-topic-arn>
      ```

- [ ] **Privileged AWS IAM User Has Been Created** - pass: every `CreateUser` event maps to an approved request, with an alarm in place
  - **Console**:
    - Verify: CloudTrail > Event history > Lookup attributes `Event name` = `CreateUser` > every event maps to an approved request, and CloudWatch > Alarms > All alarms > an alarm on the metric of the `CreateUser` metric filter shows `Actions` = `Actions enabled` with an SNS topic
    - Fix: IAM > Users > select any unrecognised user > Delete > type the user name > Delete; then CloudWatch > Logs > Log groups > <cloudtrail-log-group> > Metric filters > Create metric filter > Filter pattern `{ ($.eventName = "CreateUser") || ($.eventName = "AttachUserPolicy") || ($.eventName = "CreateAccessKey") }` > Next > Filter name `UserCreated`, Metric namespace `CISBenchmark`, Metric name `UserCreated`, Metric value `1` > Next > Create metric filter > select the filter > Create alarm > Threshold `Greater/Equal` than `1` > Next > Notification > an on-call SNS topic > Next > Alarm name `UserCreated` > Create alarm
  - **CLI**:
    - Verify:
      ```bash
      aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=CreateUser \
        --max-results 20 --query 'Events[].{Time:EventTime, By:Username, Resources:Resources[].ResourceName}' --output table
      ```
    - Verify:
      ```bash
      aws logs describe-metric-filters --log-group-name <cloudtrail-log-group> \
        --query "metricFilters[?contains(filterPattern, 'CreateUser')].{name:filterName, metric:metricTransformations[0].metricName}" \
        --output table
      ```
    - Verify:
      ```bash
      aws cloudwatch describe-alarms \
        --query 'MetricAlarms[].{name:AlarmName, metric:MetricName, actions:AlarmActions}' --output table
      ```
    - Expect: every user created in the window is one you expected, the second command returns a filter, and that filter's `metric` appears in the third command's output with a non-empty `actions` list. Creating a second admin identity is how an attacker keeps access after the original entry point is closed.
    - Fix: `aws iam delete-user --user-name <unrecognised-user>`
    - Fix:
      ```bash
      aws logs put-metric-filter --log-group-name <cloudtrail-log-group> --filter-name UserCreated \
        --filter-pattern '{ ($.eventName = "CreateUser") || ($.eventName = "AttachUserPolicy") || ($.eventName = "CreateAccessKey") }' \
        --metric-transformations metricName=UserCreated,metricNamespace=CISBenchmark,metricValue=1
      ```
    - Fix:
      ```bash
      aws cloudwatch put-metric-alarm --alarm-name UserCreated --namespace CISBenchmark --metric-name UserCreated \
        --statistic Sum --period 300 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
        --evaluation-periods 1 --alarm-actions <sns-topic-arn>
      ```

- [ ] **IAM Configuration Changes** - pass: a metric filter and alarm exist for IAM configuration changes
  - **Console**:
    - Verify: CloudWatch > Logs > Log groups > <cloudtrail-log-group> > Metric filters > a filter whose pattern matches `iam.amazonaws.com` (or the specific policy and role event names) is listed, and CloudWatch > Alarms > All alarms > an alarm on that filter's metric shows `Actions` = `Actions enabled` with an SNS topic
    - Fix: CloudWatch > Logs > Log groups > <cloudtrail-log-group> > Metric filters > Create metric filter > Filter pattern `{ ($.eventSource = "iam.amazonaws.com") && (($.eventName = "Put*Policy") || ($.eventName = "Attach*Policy") || ($.eventName = "Create*") || ($.eventName = "Delete*")) }` > Next > Filter name `IAMChanges`, Metric namespace `CISBenchmark`, Metric name `IAMChanges`, Metric value `1` > Next > Create metric filter > select the filter > Create alarm > Threshold `Greater/Equal` than `1` > Next > Notification > an SNS topic with a real subscriber > Next > Alarm name `IAMChanges` > Create alarm
  - **CLI**:
    - Verify:
      ```bash
      aws logs describe-metric-filters --log-group-name <cloudtrail-log-group> \
        --query 'metricFilters[].{name:filterName, pattern:filterPattern, metric:metricTransformations[0].metricName}' --output table
      ```
    - Verify:
      ```bash
      aws cloudwatch describe-alarms \
        --query 'MetricAlarms[].{name:AlarmName, metric:MetricName, actions:AlarmActions}' --output table
      ```
    - Expect: a filter matching IAM events (`iam.amazonaws.com`, or the specific policy and role events) exists, and its `metric` appears in the second command's output with a non-empty `actions` list. A filter with no alarm produces a number nobody looks at.
    - Fix:
      ```bash
      aws logs put-metric-filter --log-group-name <cloudtrail-log-group> --filter-name IAMChanges \
        --filter-pattern '{ ($.eventSource = "iam.amazonaws.com") && (($.eventName = "Put*Policy") || ($.eventName = "Attach*Policy") || ($.eventName = "Create*") || ($.eventName = "Delete*")) }' \
        --metric-transformations metricName=IAMChanges,metricNamespace=CISBenchmark,metricValue=1
      ```
    - Fix:
      ```bash
      aws cloudwatch put-metric-alarm --alarm-name IAMChanges --namespace CISBenchmark --metric-name IAMChanges \
        --statistic Sum --period 300 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
        --evaluation-periods 1 --alarm-actions <sns-topic-arn>
      ```

- [ ] **Sign-In Events** - pass: a metric filter and alarm exist for console sign-in without MFA and for failed sign-ins
  - **Console**:
    - Verify: CloudWatch > Logs > Log groups > <cloudtrail-log-group> > Metric filters > one filter matches `ConsoleLogin` with `MFAUsed != "Yes"` and another matches `errorMessage = "Failed authentication"`, and CloudWatch > Alarms > All alarms > an alarm on each filter's metric shows `Actions` = `Actions enabled` with an SNS topic
    - Fix: CloudWatch > Logs > Log groups > <cloudtrail-log-group> > Metric filters > Create metric filter > Filter pattern `{ ($.eventName = "ConsoleLogin") && ($.additionalEventData.MFAUsed != "Yes") && ($.userIdentity.type = "IAMUser") }` > Next > Filter name `ConsoleSignInWithoutMFA`, Metric namespace `CISBenchmark`, Metric name `ConsoleSignInWithoutMFA`, Metric value `1` > Next > Create metric filter > select the filter > Create alarm > Threshold `Greater/Equal` than `1` > Next > Notification > an SNS topic > Next > Alarm name `ConsoleSignInWithoutMFA` > Create alarm; repeat with Filter pattern `{ ($.eventName = "ConsoleLogin") && ($.errorMessage = "Failed authentication") }` and name `ConsoleSignInFailures`
  - **CLI**:
    - Verify:
      ```bash
      aws logs describe-metric-filters --log-group-name <cloudtrail-log-group> \
        --query "metricFilters[?contains(filterPattern, 'ConsoleLogin')].{name:filterName, pattern:filterPattern, metric:metricTransformations[0].metricName}" \
        --output table
      ```
    - Verify:
      ```bash
      aws cloudwatch describe-alarms \
        --query 'MetricAlarms[].{name:AlarmName, metric:MetricName, actions:AlarmActions}' --output table
      ```
    - Expect: filters exist for both `ConsoleLogin` with `additionalEventData.MFAUsed = "No"` and for `errorMessage = "Failed authentication"`, and each filter's `metric` appears in the second command's output with a non-empty `actions` list. Password spraying is only visible if failures are counted.
    - Fix:
      ```bash
      aws logs put-metric-filter --log-group-name <cloudtrail-log-group> --filter-name ConsoleSignInWithoutMFA \
        --filter-pattern '{ ($.eventName = "ConsoleLogin") && ($.additionalEventData.MFAUsed != "Yes") && ($.userIdentity.type = "IAMUser") }' \
        --metric-transformations metricName=ConsoleSignInWithoutMFA,metricNamespace=CISBenchmark,metricValue=1
      ```
    - Fix:
      ```bash
      aws logs put-metric-filter --log-group-name <cloudtrail-log-group> --filter-name ConsoleSignInFailures \
        --filter-pattern '{ ($.eventName = "ConsoleLogin") && ($.errorMessage = "Failed authentication") }' \
        --metric-transformations metricName=ConsoleSignInFailures,metricNamespace=CISBenchmark,metricValue=1
      ```
    - Fix:
      ```bash
      aws cloudwatch put-metric-alarm --alarm-name ConsoleSignInWithoutMFA --namespace CISBenchmark \
        --metric-name ConsoleSignInWithoutMFA --statistic Sum --period 300 --threshold 1 \
        --comparison-operator GreaterThanOrEqualToThreshold --evaluation-periods 1 --alarm-actions <sns-topic-arn>
      ```

---

## Storage (S3)

#### Public Access

- [ ] **Enable S3 Block Public Access for AWS Accounts** - pass: all four account-level block settings are `true`
  - **Console**:
    - Verify: S3 > Block Public Access settings for this account > all four settings under `Block all public access` read `On`
    - Fix: S3 > Block Public Access settings for this account > Edit > check `Block all public access` > Save changes > type `confirm` > Confirm
  - **CLI**:
    - Verify:
      ```bash
      aws s3control get-public-access-block --account-id $(aws sts get-caller-identity --query Account --output text) \
        --query 'PublicAccessBlockConfiguration'
      ```
    - Expect: `BlockPublicAcls`, `IgnorePublicAcls`, `BlockPublicPolicy` and `RestrictPublicBuckets` are all `true` (a `NoSuchPublicAccessBlockConfiguration` error means it is not configured at all). This is the account-wide backstop that survives a mistake in any single bucket policy.
    - Fix:
      ```bash
      aws s3control put-public-access-block --account-id <account-id> \
        --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
      ```

- [ ] **Enable S3 Block Public Access for S3 Buckets** - pass: all four block settings are `true` on every bucket
  - **Console**:
    - Verify: S3 > General purpose buckets > <bucket> > Permissions > Block public access (bucket settings) > all four settings read `On`
    - Fix: S3 > General purpose buckets > <bucket> > Permissions > Block public access (bucket settings) > Edit > check `Block all public access` > Save changes > type `confirm` > Confirm
  - **CLI**:
    - Verify:
      ```bash
      aws s3api list-buckets --query 'Buckets[].Name' --output text | tr '\t' '\n' | while read b; do
        echo "== $b"
        aws s3api get-public-access-block --bucket "$b" --query 'PublicAccessBlockConfiguration' 2>&1 | tr -d '\n'
        echo
      done
      ```
    - Expect: every bucket returns all four settings `true`. An error instead of a configuration means that bucket relies solely on the account setting, which a future administrator can relax.
    - Fix:
      ```bash
      aws s3api put-public-access-block --bucket <bucket> \
        --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
      ```

- [ ] **S3 Bucket Public 'READ' Access** - pass: no bucket ACL grants `AllUsers` or `AuthenticatedUsers`
  - **Console**:
    - Verify: S3 > General purpose buckets > <bucket> > Permissions > Access control list (ACL) > no grant is listed for `Everyone (public access)` or `Authenticated users group (anyone with an AWS account)`
    - Fix: S3 > General purpose buckets > <bucket> > Permissions > Access control list (ACL) > Edit > clear every box under `Everyone (public access)` and `Authenticated users group` > Save changes; then Permissions > Object Ownership > Edit > `ACLs disabled (recommended)` > Save changes
  - **CLI**:
    - Verify:
      ```bash
      aws s3api list-buckets --query 'Buckets[].Name' --output text | tr '\t' '\n' | while read b; do
        g=$(aws s3api get-bucket-acl --bucket "$b" \
          --query "Grants[?contains(to_string(Grantee.URI), 'AllUsers') || contains(to_string(Grantee.URI), 'AuthenticatedUsers')].Permission" \
          --output text 2>/dev/null)
        [ -n "$g" ] && echo "$b: $g"
      done
      ```
    - Expect: no output. `AllUsers` is the entire internet; `AuthenticatedUsers` is every AWS account holder, which is not meaningfully narrower.
    - Fix: `aws s3api put-bucket-acl --bucket <bucket> --acl private`
    - Fix:
      ```bash
      aws s3api put-bucket-ownership-controls --bucket <bucket> \
        --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
      ```

- [ ] **S3 Bucket Public Access Via Policy** - pass: no bucket policy allows `Principal: "*"` without a restricting condition
  - **Console**:
    - Verify: S3 > General purpose buckets > the `Access` column shows no bucket marked `Public`, and <bucket> > Permissions > Bucket policy > every statement with `"Principal": "*"` carries a `Condition` such as `aws:SourceVpce` or a CloudFront origin access control
    - Fix: S3 > General purpose buckets > <bucket> > Permissions > Bucket policy > Edit > replace the wildcard principal with the specific role ARNs that need access (or remove the statement) > Save changes
  - **CLI**:
    - Verify:
      ```bash
      aws s3api list-buckets --query 'Buckets[].Name' --output text | tr '\t' '\n' | while read b; do
        s=$(aws s3api get-bucket-policy-status --bucket "$b" --query 'PolicyStatus.IsPublic' --output text 2>/dev/null)
        [ "$s" = "True" ] && echo "PUBLIC: $b"
      done
      ```
    - Verify: `aws s3api get-bucket-policy --bucket <bucket> --query Policy --output text`
    - Expect: the loop prints nothing, and for any bucket it does flag, the policy's wildcard principal is paired with a hard condition such as `aws:SourceVpce` or a CloudFront OAC. An unconditioned wildcard principal is the whole internet.
    - Fix: `aws s3api delete-bucket-policy --bucket <bucket>`
    - Fix: `aws s3api put-bucket-policy --bucket <bucket> --policy file://policy.json`

- [ ] **S3 Cross Account Access** - pass: every external account in a bucket policy is known and approved
  - **Console**:
    - Verify: S3 > General purpose buckets > <bucket> > Permissions > Bucket policy > every account ID in a principal ARN is your own or a current, documented partner
    - Fix: S3 > General purpose buckets > <bucket> > Permissions > Bucket policy > Edit > remove the stale principal > Save changes
  - **CLI**:
    - Verify:
      ```bash
      aws s3api list-buckets --query 'Buckets[].Name' --output text | tr '\t' '\n' | while read b; do
        p=$(aws s3api get-bucket-policy --bucket "$b" --query Policy --output text 2>/dev/null)
        [ -n "$p" ] && echo "$p" | grep -oE 'arn:aws:iam::[0-9]{12}' | sort -u | sed "s|^|$b: |"
      done
      ```
    - Expect: every account ID other than your own is a current, documented partner. Data leaves through forgotten cross-account grants more often than through public buckets.
    - Fix: `aws s3api put-bucket-policy --bucket <bucket> --policy file://policy.json`

#### Logging & Detection

- [ ] **S3 Bucket Logging Enabled** - pass: every bucket has a `LoggingEnabled` target
  - **Console**:
    - Verify: S3 > General purpose buckets > <bucket> > Properties > Server access logging > reads `Enabled` with a destination bucket
    - Fix: S3 > General purpose buckets > <bucket> > Properties > Server access logging > Edit > `Enable` > Destination `s3://<log-bucket>/<bucket>/` > Save changes
  - **CLI**:
    - Verify:
      ```bash
      aws s3api list-buckets --query 'Buckets[].Name' --output text | tr '\t' '\n' | while read b; do
        t=$(aws s3api get-bucket-logging --bucket "$b" --query 'LoggingEnabled.TargetBucket' --output text 2>/dev/null)
        echo "$b: ${t:-NONE}"
      done
      ```
    - Expect: no bucket shows `NONE` or `None`, except the log target itself. Without access logging there is no record of what an attacker read, which turns a contained incident into an unbounded disclosure notification.
    - Fix:
      ```bash
      aws s3api put-bucket-logging --bucket <bucket> \
        --bucket-logging-status '{"LoggingEnabled":{"TargetBucket":"<log-bucket>","TargetPrefix":"<bucket>/"}}'
      ```

- [ ] **S3 Configuration Changes** - pass: a metric filter and alarm exist for S3 policy and ACL changes
  - **Console**:
    - Verify: CloudWatch > Logs > Log groups > <cloudtrail-log-group> > Metric filters > a filter whose pattern covers `PutBucketPolicy`, `PutBucketAcl`, `DeleteBucketPolicy` and `PutBucketPublicAccessBlock` is listed, and CloudWatch > Alarms > All alarms > an alarm on that filter's metric shows `Actions` = `Actions enabled` with an SNS topic
    - Fix: CloudWatch > Logs > Log groups > <cloudtrail-log-group> > Metric filters > Create metric filter > Filter pattern `{ ($.eventSource = "s3.amazonaws.com") && (($.eventName = "PutBucketAcl") || ($.eventName = "PutBucketPolicy") || ($.eventName = "DeleteBucketPolicy") || ($.eventName = "PutBucketPublicAccessBlock")) }` > Next > Filter name `S3PolicyChanges`, Metric namespace `CISBenchmark`, Metric name `S3PolicyChanges`, Metric value `1` > Next > Create metric filter > select the filter > Create alarm > Threshold `Greater/Equal` than `1` > Next > Notification > an SNS topic > Next > Alarm name `S3PolicyChanges` > Create alarm
  - **CLI**:
    - Verify:
      ```bash
      aws logs describe-metric-filters --log-group-name <cloudtrail-log-group> \
        --query "metricFilters[?contains(filterPattern, 's3.amazonaws.com')].{name:filterName, pattern:filterPattern, metric:metricTransformations[0].metricName}" \
        --output table
      ```
    - Verify:
      ```bash
      aws cloudwatch describe-alarms \
        --query 'MetricAlarms[].{name:AlarmName, metric:MetricName, actions:AlarmActions}' --output table
      ```
    - Expect: a filter covering `PutBucketPolicy`, `PutBucketAcl`, `DeleteBucketPolicy` and `PutBucketPublicAccessBlock` exists, and its `metric` appears in the second command's output with a non-empty `actions` list. Making a bucket public is a single API call.
    - Fix:
      ```bash
      aws logs put-metric-filter --log-group-name <cloudtrail-log-group> --filter-name S3PolicyChanges \
        --filter-pattern '{ ($.eventSource = "s3.amazonaws.com") && (($.eventName = "PutBucketAcl") || ($.eventName = "PutBucketPolicy") || ($.eventName = "DeleteBucketPolicy") || ($.eventName = "PutBucketPublicAccessBlock")) }' \
        --metric-transformations metricName=S3PolicyChanges,metricNamespace=CISBenchmark,metricValue=1
      ```
    - Fix:
      ```bash
      aws cloudwatch put-metric-alarm --alarm-name S3PolicyChanges --namespace CISBenchmark --metric-name S3PolicyChanges \
        --statistic Sum --period 300 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
        --evaluation-periods 1 --alarm-actions <sns-topic-arn>
      ```

- [ ] **Publicly Accessible CloudTrail Buckets** - pass: no CloudTrail bucket is public
  - **Console**:
    - Verify: CloudTrail > Trails > <trail> > General details > note the `Trail log location` bucket; then S3 > General purpose buckets > that bucket's `Access` column reads `Bucket and objects not public`
    - Fix: S3 > General purpose buckets > <bucket> > Permissions > Block public access (bucket settings) > Edit > check `Block all public access` > Save changes > type `confirm` > Confirm; then Permissions > Bucket policy > Edit > remove the public statement > Save changes
  - **CLI**:
    - Verify:
      ```bash
      aws cloudtrail describe-trails --query 'trailList[].S3BucketName' --output text | tr '\t' '\n' | sort -u | while read b; do
        echo "$b: $(aws s3api get-bucket-policy-status --bucket "$b" --query 'PolicyStatus.IsPublic' --output text 2>/dev/null)"
      done
      ```
    - Expect: `False` for every bucket. A public CloudTrail bucket hands over a complete map of your account - principals, resources, API patterns - and lets an attacker confirm whether their activity was recorded.
    - Fix:
      ```bash
      aws s3api put-public-access-block --bucket <bucket> \
        --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
      ```

---

## Compute (EC2)

#### Network Exposure

- [ ] **EC2 Instance Not In Public Subnet** - pass: no application or data instance sits in a subnet with a route to an internet gateway
  - **Console**:
    - Verify: EC2 > Instances > the `Public IPv4 address` column is empty except for bastions and public load balancer targets; then VPC > Subnets > <subnet> > Route table > Routes > no `0.0.0.0/0` route with an `igw-` target on an application subnet
    - Fix: EC2 > Instances > select the instance > Actions > Image and templates > Create image > Create image; then EC2 > AMIs > select the image > Launch instance from AMI > Network settings > Subnet = a private subnet > Auto-assign public IP `Disable` > Launch instance; then terminate the original and reach the new one through Systems Manager > Session Manager
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-instances \
        --query "Reservations[].Instances[].{id:InstanceId, subnet:SubnetId, public:PublicIpAddress, name:Tags[?Key=='Name'].Value|[0]}" \
        --output table
      ```
    - Verify:
      ```bash
      aws ec2 describe-route-tables --filters Name=association.subnet-id,Values=<subnet> \
        --query 'RouteTables[].Routes[].[DestinationCidrBlock,GatewayId]' --output table
      ```
    - Expect: only instances that must terminate inbound traffic (a bastion, a public load balancer target) have a `public` address, and no application subnet's route table pairs `0.0.0.0/0` with an `igw-` gateway. A public subnet puts every instance in it one security-group rule away from the internet.
    - Fix:
      ```bash
      aws ec2 run-instances --image-id <ami> --instance-type <type> --subnet-id <private-subnet> \
        --security-group-ids <sg> --iam-instance-profile Name=<profile> --no-associate-public-ip-address
      ```
    - Fix: `aws ec2 terminate-instances --instance-ids <old-instance-id>`

- [ ] **Disable Public IP Address Assignment for EC2 Instances** - pass: `MapPublicIpOnLaunch` = `false` on every subnet
  - **Console**:
    - Verify: VPC > Subnets > the `Auto-assign public IPv4 address` column reads `No` for every subnet that is not deliberately public
    - Fix: VPC > Subnets > select the subnet > Actions > Edit subnet settings > uncheck `Enable auto-assign public IPv4 address` > Save
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-subnets \
        --query 'Subnets[].{id:SubnetId, vpc:VpcId, autoPublicIp:MapPublicIpOnLaunch}' --output table
      ```
    - Expect: `autoPublicIp` is `False` everywhere except deliberately public subnets. When it is `True`, every instance launched into that subnet becomes internet-reachable by default, including ones launched by autoscaling.
    - Fix: `aws ec2 modify-subnet-attribute --subnet-id <subnet> --no-map-public-ip-on-launch`

- [ ] **App-Tier Publicly Shared AMI** - pass: no AMI backing an application-tier instance is public
  - **Console**:
    - Verify: EC2 > Instances > <instance> > Details > Instance summary > note the `AMI ID`; then EC2 > AMIs > filter `Owned by me` > that AMI's `Visibility` column reads `Private`
    - Fix: EC2 > AMIs > select the AMI > Actions > Edit AMI permissions > `Private` > Save changes; then rebuild the affected instances from a private image and rotate every credential the old image contained
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-instances --query 'Reservations[].Instances[].ImageId' --output text | tr '\t' '\n' | sort -u | while read i; do
        p=$(aws ec2 describe-images --image-ids "$i" --query 'Images[0].Public' --output text 2>/dev/null)
        [ "$p" = "True" ] && echo "public AMI in use: $i"
      done
      ```
    - Expect: no output. A public image backing a running application tier leaks whatever is baked into it, and the blast radius is highest on the tier that is actually serving traffic.
    - Fix: `aws ec2 modify-image-attribute --image-id <ami> --launch-permission "Remove=[{Group=all}]"`

- [ ] **Publicly Shared AMI** - pass: no owned AMI has public launch permission
  - **Console**:
    - Verify: EC2 > AMIs > filter `Owned by me` > the `Visibility` column reads `Private` on every row
    - Fix: EC2 > AMIs > select the AMI > Actions > Edit AMI permissions > `Private` > Save changes
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-images --owners self --query "Images[?Public].{id:ImageId, name:Name}" --output table
      ```
    - Expect: no rows. A public AMI can be launched by anyone, and images routinely carry baked-in credentials, source code and internal hostnames in their filesystem.
    - Fix: `aws ec2 modify-image-attribute --image-id <ami> --launch-permission "Remove=[{Group=all}]"`

- [ ] **AMI Cross-Account Access** - pass: every account with AMI launch permission is known and approved
  - **Console**:
    - Verify: EC2 > AMIs > filter `Owned by me` > <ami> > Permissions > every account ID under `Shared accounts` is a current member of your Organization or a documented partner
    - Fix: EC2 > AMIs > select the AMI > Actions > Edit AMI permissions > Shared accounts > Remove next to the account ID > Save changes
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-images --owners self --query 'Images[].ImageId' --output text | tr '\t' '\n' | while read i; do
        a=$(aws ec2 describe-image-attribute --image-id "$i" --attribute launchPermission \
          --query 'LaunchPermissions[].UserId' --output text)
        [ -n "$a" ] && echo "$i: $a"
      done
      ```
    - Expect: every account ID is a current member of your Organization or a documented partner. Shared AMIs are copied on first launch, so revoking access later does not recall what was taken.
    - Fix: `aws ec2 modify-image-attribute --image-id <ami> --launch-permission "Remove=[{UserId=<account-id>}]"`

#### Instance Security

- [ ] **EC2 Instance Using IAM Roles** - pass: every instance has an `IamInstanceProfile`
  - **Console**:
    - Verify: EC2 > Instances > <instance> > Details > Instance details > `IAM Role` shows a role name for every running instance
    - Fix: EC2 > Instances > select the instance > Actions > Security > Modify IAM role > choose the role > Update IAM role; then delete and rotate the static access key it replaces
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-instances \
        --query "Reservations[].Instances[?State.Name=='running'].{id:InstanceId, profile:IamInstanceProfile.Arn}" --output table
      ```
    - Expect: no instance has a null `profile`. An instance without a role is almost always authenticating with a static access key written into the filesystem or an environment variable.
    - Fix: `aws ec2 associate-iam-instance-profile --instance-id <id> --iam-instance-profile Name=<profile>`

- [ ] **Require IMDSv2 for EC2 Instances** - pass: `HttpTokens` = `required` on every instance
  - **Console**:
    - Verify: EC2 > Instances > <instance> > Details > Instance details > `IMDSv2` reads `Required`
    - Fix: EC2 > Instances > select the instance > Actions > Instance settings > Modify instance metadata options > IMDSv2 `Required` > Metadata response hop limit `1` > Save
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-instances \
        --query "Reservations[].Instances[?State.Name=='running'].{id:InstanceId, tokens:MetadataOptions.HttpTokens, hops:MetadataOptions.HttpPutResponseHopLimit}" \
        --output table
      ```
    - Expect: `tokens` is `required` and `hops` is `1`. With `optional`, a server-side request forgery in your application can read the instance's role credentials with a single unauthenticated GET - the mechanism behind several large cloud breaches.
    - Fix:
      ```bash
      aws ec2 modify-instance-metadata-options --instance-id <id> --http-tokens required \
        --http-endpoint enabled --http-put-response-hop-limit 1
      ```

#### Security Groups

Run each port check twice - once for IPv4 and once for IPv6. The `ip-permission.cidr` filter matches IPv4 only, so a rule opened to `::/0` is invisible to it.

- [ ] **Default Security Group Unrestricted** - pass: every default security group has no ingress and no egress rules
  - **Console**:
    - Verify: EC2 > Security Groups > filter `Security group name: default` > select each group > the Inbound rules tab and the Outbound rules tab are both empty
    - Fix: EC2 > Security Groups > select the default group > Inbound rules > Edit inbound rules > Delete every rule > Save rules; then Outbound rules > Edit outbound rules > Delete every rule > Save rules
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-security-groups --filters Name=group-name,Values=default \
        --query 'SecurityGroups[].{id:GroupId, vpc:VpcId, ingress:length(IpPermissions), egress:length(IpPermissionsEgress)}' \
        --output table
      ```
    - Expect: `ingress` and `egress` are both `0`. The default group is attached to anything launched without an explicit group, so its rules apply to resources nobody meant to expose.
    - Fix:
      ```bash
      aws ec2 revoke-security-group-ingress --group-id <sg> \
        --ip-permissions "$(aws ec2 describe-security-groups --group-ids <sg> --query 'SecurityGroups[0].IpPermissions' --output json)"
      ```
    - Fix:
      ```bash
      aws ec2 revoke-security-group-egress --group-id <sg> \
        --ip-permissions "$(aws ec2 describe-security-groups --group-ids <sg> --query 'SecurityGroups[0].IpPermissionsEgress' --output json)"
      ```

- [ ] **Unrestricted SSH Access** - pass: no security group allows port 22 from `0.0.0.0/0` or `::/0`
  - **Console**:
    - Verify: EC2 > Security Groups > filter `Port range: 22` > open each group > Inbound rules > the `Source` column shows no `0.0.0.0/0` or `::/0` on port 22
    - Fix: EC2 > Security Groups > select the group > Inbound rules > Edit inbound rules > Delete the port 22 rule whose source is `0.0.0.0/0` or `::/0` > Save rules
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=22 Name=ip-permission.to-port,Values=22 Name=ip-permission.cidr,Values=0.0.0.0/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=22 Name=ip-permission.to-port,Values=22 Name=ip-permission.ipv6-cidr,Values=::/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Expect: both commands return an empty table. Open SSH is scanned and brute-forced continuously; it is the single most exploited misconfiguration in AWS, and SSM Session Manager needs no inbound rule at all.
    - Fix: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 22 --cidr 0.0.0.0/0`
    - Fix:
      ```bash
      aws ec2 revoke-security-group-ingress --group-id <sg> \
        --ip-permissions 'IpProtocol=tcp,FromPort=22,ToPort=22,Ipv6Ranges=[{CidrIpv6=::/0}]'
      ```

- [ ] **Unrestricted RDP Access** - pass: no security group allows port 3389 from `0.0.0.0/0` or `::/0`
  - **Console**:
    - Verify: EC2 > Security Groups > filter `Port range: 3389` > open each group > Inbound rules > the `Source` column shows no `0.0.0.0/0` or `::/0` on port 3389
    - Fix: EC2 > Security Groups > select the group > Inbound rules > Edit inbound rules > Delete the port 3389 rule whose source is `0.0.0.0/0` or `::/0` > Save rules
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=3389 Name=ip-permission.to-port,Values=3389 Name=ip-permission.cidr,Values=0.0.0.0/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=3389 Name=ip-permission.to-port,Values=3389 Name=ip-permission.ipv6-cidr,Values=::/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Expect: both commands return an empty table. Exposed RDP is the primary initial-access vector for ransomware operators; use SSM Session Manager or Fleet Manager remote desktop instead.
    - Fix: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 3389 --cidr 0.0.0.0/0`
    - Fix:
      ```bash
      aws ec2 revoke-security-group-ingress --group-id <sg> \
        --ip-permissions 'IpProtocol=tcp,FromPort=3389,ToPort=3389,Ipv6Ranges=[{CidrIpv6=::/0}]'
      ```

- [ ] **Unrestricted MySQL Database Access** - pass: no security group allows port 3306 from `0.0.0.0/0` or `::/0`
  - **Console**:
    - Verify: EC2 > Security Groups > filter `Port range: 3306` > open each group > Inbound rules > the `Source` column shows no `0.0.0.0/0` or `::/0` on port 3306
    - Fix: EC2 > Security Groups > select the group > Inbound rules > Edit inbound rules > Delete the port 3306 rule whose source is `0.0.0.0/0` or `::/0` > Add rule > Type `MYSQL/Aurora` > Source = the application tier's security group > Save rules
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=3306 Name=ip-permission.to-port,Values=3306 Name=ip-permission.cidr,Values=0.0.0.0/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=3306 Name=ip-permission.to-port,Values=3306 Name=ip-permission.ipv6-cidr,Values=::/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Expect: both commands return an empty table. A database reachable from the internet is one credential-stuffing run away from full data disclosure.
    - Fix: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 3306 --cidr 0.0.0.0/0`
    - Fix:
      ```bash
      aws ec2 revoke-security-group-ingress --group-id <sg> \
        --ip-permissions 'IpProtocol=tcp,FromPort=3306,ToPort=3306,Ipv6Ranges=[{CidrIpv6=::/0}]'
      ```
    - Fix:
      ```bash
      aws ec2 authorize-security-group-ingress --group-id <sg> --protocol tcp --port 3306 \
        --source-group <app-sg>
      ```

- [ ] **Unrestricted PostgreSQL Database Access** - pass: no security group allows port 5432 from `0.0.0.0/0` or `::/0`
  - **Console**:
    - Verify: EC2 > Security Groups > filter `Port range: 5432` > open each group > Inbound rules > the `Source` column shows no `0.0.0.0/0` or `::/0` on port 5432
    - Fix: EC2 > Security Groups > select the group > Inbound rules > Edit inbound rules > Delete the port 5432 rule whose source is `0.0.0.0/0` or `::/0` > Add rule > Type `PostgreSQL` > Source = the application tier's security group > Save rules
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=5432 Name=ip-permission.to-port,Values=5432 Name=ip-permission.cidr,Values=0.0.0.0/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=5432 Name=ip-permission.to-port,Values=5432 Name=ip-permission.ipv6-cidr,Values=::/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Expect: both commands return an empty table. A PostgreSQL listener on the internet is brute-forced within hours, and only the application tier should ever reach it.
    - Fix: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 5432 --cidr 0.0.0.0/0`
    - Fix:
      ```bash
      aws ec2 revoke-security-group-ingress --group-id <sg> \
        --ip-permissions 'IpProtocol=tcp,FromPort=5432,ToPort=5432,Ipv6Ranges=[{CidrIpv6=::/0}]'
      ```
    - Fix:
      ```bash
      aws ec2 authorize-security-group-ingress --group-id <sg> --protocol tcp --port 5432 \
        --source-group <app-sg>
      ```

- [ ] **Unrestricted MSSQL Database Access** - pass: no security group allows port 1433 from `0.0.0.0/0` or `::/0`
  - **Console**:
    - Verify: EC2 > Security Groups > filter `Port range: 1433` > open each group > Inbound rules > the `Source` column shows no `0.0.0.0/0` or `::/0` on port 1433
    - Fix: EC2 > Security Groups > select the group > Inbound rules > Edit inbound rules > Delete the port 1433 rule whose source is `0.0.0.0/0` or `::/0` > Add rule > Type `MSSQL` > Source = the application tier's security group > Save rules
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=1433 Name=ip-permission.to-port,Values=1433 Name=ip-permission.cidr,Values=0.0.0.0/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=1433 Name=ip-permission.to-port,Values=1433 Name=ip-permission.ipv6-cidr,Values=::/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Expect: both commands return an empty table. SQL Server on the internet is a standing target for `sa` password brute force and `xp_cmdshell` abuse once a login lands.
    - Fix: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 1433 --cidr 0.0.0.0/0`
    - Fix:
      ```bash
      aws ec2 revoke-security-group-ingress --group-id <sg> \
        --ip-permissions 'IpProtocol=tcp,FromPort=1433,ToPort=1433,Ipv6Ranges=[{CidrIpv6=::/0}]'
      ```
    - Fix:
      ```bash
      aws ec2 authorize-security-group-ingress --group-id <sg> --protocol tcp --port 1433 \
        --source-group <app-sg>
      ```

- [ ] **Unrestricted MongoDB Access** - pass: no security group allows port 27017 from `0.0.0.0/0` or `::/0`
  - **Console**:
    - Verify: EC2 > Security Groups > filter `Port range: 27017` > open each group > Inbound rules > the `Source` column shows no `0.0.0.0/0` or `::/0` on port 27017
    - Fix: EC2 > Security Groups > select the group > Inbound rules > Edit inbound rules > Delete the port 27017 rule whose source is `0.0.0.0/0` or `::/0` > Save rules; then confirm authentication is enabled on the database itself
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=27017 Name=ip-permission.to-port,Values=27017 Name=ip-permission.cidr,Values=0.0.0.0/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=27017 Name=ip-permission.to-port,Values=27017 Name=ip-permission.ipv6-cidr,Values=::/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Expect: both commands return an empty table. Internet-exposed MongoDB has been mass-swept and ransomed repeatedly, including instances that were only briefly open.
    - Fix: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 27017 --cidr 0.0.0.0/0`
    - Fix:
      ```bash
      aws ec2 revoke-security-group-ingress --group-id <sg> \
        --ip-permissions 'IpProtocol=tcp,FromPort=27017,ToPort=27017,Ipv6Ranges=[{CidrIpv6=::/0}]'
      ```

- [ ] **Unrestricted Redis Cache Access** - pass: no security group allows port 6379 from `0.0.0.0/0` or `::/0`
  - **Console**:
    - Verify: EC2 > Security Groups > filter `Port range: 6379` > open each group > Inbound rules > the `Source` column shows no `0.0.0.0/0` or `::/0` on port 6379
    - Fix: EC2 > Security Groups > select the group > Inbound rules > Edit inbound rules > Delete the port 6379 rule whose source is `0.0.0.0/0` or `::/0` > Save rules; then ElastiCache > Redis OSS caches > <cache> > Modify > enable `AUTH` and `Encryption in transit` > Save changes
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=6379 Name=ip-permission.to-port,Values=6379 Name=ip-permission.cidr,Values=0.0.0.0/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=6379 Name=ip-permission.to-port,Values=6379 Name=ip-permission.ipv6-cidr,Values=::/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Expect: both commands return an empty table. Redis is unauthenticated by default and its `CONFIG` command can write files to disk, so exposure is often direct code execution.
    - Fix: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 6379 --cidr 0.0.0.0/0`
    - Fix:
      ```bash
      aws ec2 revoke-security-group-ingress --group-id <sg> \
        --ip-permissions 'IpProtocol=tcp,FromPort=6379,ToPort=6379,Ipv6Ranges=[{CidrIpv6=::/0}]'
      ```

- [ ] **Unrestricted SMTP Access** - pass: no security group allows port 25 from `0.0.0.0/0` or `::/0`
  - **Console**:
    - Verify: EC2 > Security Groups > filter `Port range: 25` > open each group > Inbound rules > the `Source` column shows no `0.0.0.0/0` or `::/0` on port 25
    - Fix: EC2 > Security Groups > select the group > Inbound rules > Edit inbound rules > Delete the port 25 rule whose source is `0.0.0.0/0` or `::/0` > Save rules; send mail through SES or a managed provider instead of running a relay
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=25 Name=ip-permission.to-port,Values=25 Name=ip-permission.cidr,Values=0.0.0.0/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=25 Name=ip-permission.to-port,Values=25 Name=ip-permission.ipv6-cidr,Values=::/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Expect: both commands return an empty table. An open relay gets your address space blocklisted and your domain used for phishing that appears to come from you.
    - Fix: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 25 --cidr 0.0.0.0/0`
    - Fix:
      ```bash
      aws ec2 revoke-security-group-ingress --group-id <sg> \
        --ip-permissions 'IpProtocol=tcp,FromPort=25,ToPort=25,Ipv6Ranges=[{CidrIpv6=::/0}]'
      ```

- [ ] **Unrestricted NetBIOS Access** - pass: no security group allows ports 137-139 from `0.0.0.0/0` or `::/0`
  - **Console**:
    - Verify: EC2 > Security Groups > filter `Port range: 137`, then `138`, then `139` > open each group > Inbound rules > the `Source` column shows no `0.0.0.0/0` or `::/0` on ports 137-139
    - Fix: EC2 > Security Groups > select the group > Inbound rules > Edit inbound rules > Delete every rule on ports 137, 138 or 139 whose source is `0.0.0.0/0` or `::/0` > Save rules
  - **CLI**:
    - Verify:
      ```bash
      for p in 137 138 139; do
        aws ec2 describe-security-groups \
          --filters Name=ip-permission.from-port,Values=$p Name=ip-permission.to-port,Values=$p Name=ip-permission.cidr,Values=0.0.0.0/0 \
          --query "SecurityGroups[].[GroupId,GroupName]" --output text
      done
      ```
    - Verify:
      ```bash
      for p in 137 138 139; do
        aws ec2 describe-security-groups \
          --filters Name=ip-permission.from-port,Values=$p Name=ip-permission.to-port,Values=$p Name=ip-permission.ipv6-cidr,Values=::/0 \
          --query "SecurityGroups[].[GroupId,GroupName]" --output text
      done
      ```
    - Expect: both loops print nothing. NetBIOS leaks hostnames, workgroup and session data to anyone who asks, and should never cross a VPC boundary.
    - Fix:
      ```bash
      for p in 137 138 139; do for proto in tcp udp; do
        aws ec2 revoke-security-group-ingress --group-id <sg> --protocol $proto --port $p --cidr 0.0.0.0/0
      done; done
      ```
    - Fix:
      ```bash
      for p in 137 138 139; do for proto in tcp udp; do
        aws ec2 revoke-security-group-ingress --group-id <sg> \
          --ip-permissions "IpProtocol=$proto,FromPort=$p,ToPort=$p,Ipv6Ranges=[{CidrIpv6=::/0}]"
      done; done
      ```

- [ ] **Unrestricted CIFS Access** - pass: no security group allows port 445 from `0.0.0.0/0` or `::/0`
  - **Console**:
    - Verify: EC2 > Security Groups > filter `Port range: 445` > open each group > Inbound rules > the `Source` column shows no `0.0.0.0/0` or `::/0` on port 445
    - Fix: EC2 > Security Groups > select the group > Inbound rules > Edit inbound rules > Delete the port 445 rule whose source is `0.0.0.0/0` or `::/0` > Save rules; reach file shares over a VPN or use FSx with private endpoints
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=445 Name=ip-permission.to-port,Values=445 Name=ip-permission.cidr,Values=0.0.0.0/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=445 Name=ip-permission.to-port,Values=445 Name=ip-permission.ipv6-cidr,Values=::/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Expect: both commands return an empty table. SMB on 445 is the port behind EternalBlue and most self-propagating ransomware.
    - Fix: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 445 --cidr 0.0.0.0/0`
    - Fix:
      ```bash
      aws ec2 revoke-security-group-ingress --group-id <sg> \
        --ip-permissions 'IpProtocol=tcp,FromPort=445,ToPort=445,Ipv6Ranges=[{CidrIpv6=::/0}]'
      ```

- [ ] **Unrestricted RPC Access** - pass: no security group allows port 135 from `0.0.0.0/0` or `::/0`
  - **Console**:
    - Verify: EC2 > Security Groups > filter `Port range: 135` > open each group > Inbound rules > the `Source` column shows no `0.0.0.0/0` or `::/0` on port 135
    - Fix: EC2 > Security Groups > select the group > Inbound rules > Edit inbound rules > Delete the port 135 rule whose source is `0.0.0.0/0` or `::/0` > Save rules
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=135 Name=ip-permission.to-port,Values=135 Name=ip-permission.cidr,Values=0.0.0.0/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=135 Name=ip-permission.to-port,Values=135 Name=ip-permission.ipv6-cidr,Values=::/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Expect: both commands return an empty table. The RPC endpoint mapper enumerates the services running on a host and has a long history of remote code execution flaws.
    - Fix: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 135 --cidr 0.0.0.0/0`
    - Fix:
      ```bash
      aws ec2 revoke-security-group-ingress --group-id <sg> \
        --ip-permissions 'IpProtocol=tcp,FromPort=135,ToPort=135,Ipv6Ranges=[{CidrIpv6=::/0}]'
      ```

- [ ] **Unrestricted Telnet Access** - pass: no security group allows port 23 from `0.0.0.0/0` or `::/0`
  - **Console**:
    - Verify: EC2 > Security Groups > filter `Port range: 23` > open each group > Inbound rules > the `Source` column shows no `0.0.0.0/0` or `::/0` on port 23
    - Fix: EC2 > Security Groups > select the group > Inbound rules > Edit inbound rules > Delete the port 23 rule whose source is `0.0.0.0/0` or `::/0` > Save rules; then disable the telnet daemon on the host
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=23 Name=ip-permission.to-port,Values=23 Name=ip-permission.cidr,Values=0.0.0.0/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --filters Name=ip-permission.from-port,Values=23 Name=ip-permission.to-port,Values=23 Name=ip-permission.ipv6-cidr,Values=::/0 \
        --query 'SecurityGroups[].[GroupId,GroupName]' --output table
      ```
    - Expect: both commands return an empty table. Telnet carries credentials in cleartext and has no place in a current environment at all, open or not.
    - Fix: `aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port 23 --cidr 0.0.0.0/0`
    - Fix:
      ```bash
      aws ec2 revoke-security-group-ingress --group-id <sg> \
        --ip-permissions 'IpProtocol=tcp,FromPort=23,ToPort=23,Ipv6Ranges=[{CidrIpv6=::/0}]'
      ```

- [ ] **Unrestricted Outbound Access** - pass: no production security group allows all egress to `0.0.0.0/0`
  - **Console**:
    - Verify: EC2 > Security Groups > <production group> > Outbound rules > no rule with Type `All traffic` and Destination `0.0.0.0/0`
    - Fix: EC2 > Security Groups > select the group > Outbound rules > Edit outbound rules > Delete the `All traffic` to `0.0.0.0/0` rule > Add rule > Type `HTTPS` > Destination = a managed prefix list or VPC endpoint security group > Save rules
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --query "SecurityGroups[?IpPermissionsEgress[?IpProtocol=='-1' && IpRanges[?CidrIp=='0.0.0.0/0']]].{id:GroupId, name:GroupName}" \
        --output table
      ```
    - Expect: no production group is listed. Open egress is what turns a foothold into data exfiltration and command-and-control, and it is the default on every new security group, so this needs a deliberate change.
    - Fix: `aws ec2 revoke-security-group-egress --group-id <sg> --protocol all --cidr 0.0.0.0/0`
    - Fix:
      ```bash
      aws ec2 authorize-security-group-egress --group-id <sg> \
        --ip-permissions 'IpProtocol=tcp,FromPort=443,ToPort=443,PrefixListIds=[{PrefixListId=<pl-id>}]'
      ```

- [ ] **EC2 Security Group Port Range** - pass: no rule opens a contiguous range of ports
  - **Console**:
    - Verify: EC2 > Security Groups > <group> > Inbound rules > the `Port range` column shows single ports only, no `<from> - <to>` ranges
    - Fix: EC2 > Security Groups > select the group > Inbound rules > Edit inbound rules > Delete the range rule > Add rule for each port actually in use > Save rules
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-security-groups \
        --query "SecurityGroups[].{id:GroupId, name:GroupName, ranges:IpPermissions[?FromPort!=ToPort].[FromPort,ToPort]}" \
        --output json
      ```
    - Expect: `ranges` is empty for every group. A range such as 0-65535 or 1024-65535 exposes every service that will ever listen on the host, including ones added after the rule was written.
    - Fix:
      ```bash
      aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port <from>-<to> \
        --cidr <cidr>
      ```
    - Fix: `aws ec2 authorize-security-group-ingress --group-id <sg> --protocol tcp --port <port> --cidr <cidr>`

---

## Networking (VPC)

- [ ] **Default VPC in Use** - pass: no resources run in a default VPC
  - **Console**:
    - Verify: VPC > Your VPCs > note every VPC whose `Default VPC` column reads `Yes`; then EC2 > Instances > filter `VPC ID = <vpc>` > the list is empty
    - Fix: VPC > Your VPCs > select the default VPC > Actions > Delete VPC > type `delete` > Delete (after migrating workloads to a purpose-built VPC)
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-vpcs --query 'Vpcs[?IsDefault].VpcId' --output text | tr '\t' '\n' | while read v; do
        echo "$v: $(aws ec2 describe-instances --filters Name=vpc-id,Values=$v --query 'length(Reservations[].Instances[])')"
      done
      ```
    - Expect: every default VPC reports `0` instances. Default VPCs ship with a public subnet per availability zone, an internet gateway, and a permissive default security group - none of which were chosen by you.
    - Fix: `aws ec2 delete-vpc --vpc-id <vpc>`

- [ ] **VPC Flow Logs Enabled** - pass: every VPC has an active flow log
  - **Console**:
    - Verify: VPC > Your VPCs > <vpc> > Flow logs > at least one row shows `Status` = `Active` and `Filter` = `All`
    - Fix: VPC > Your VPCs > select the VPC > Actions > Create flow log > Filter `All` > Destination = a CloudWatch Logs log group or S3 bucket > IAM role > Create flow log
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-vpcs --query 'Vpcs[].VpcId' --output text | tr '\t' '\n' | while read v; do
        echo "$v: $(aws ec2 describe-flow-logs --filter Name=resource-id,Values=$v --query "length(FlowLogs[?FlowLogStatus=='ACTIVE'])")"
      done
      ```
    - Expect: every VPC reports at least `1`. Without flow logs there is no record of what talked to what, so an intrusion cannot be scoped after the fact.
    - Fix:
      ```bash
      aws ec2 create-flow-logs --resource-type VPC --resource-ids <vpc> --traffic-type ALL \
        --log-destination-type cloud-watch-logs --log-group-name <group> --deliver-logs-permission-arn <role-arn>
      ```

- [ ] **Unrestricted Network ACL Inbound Traffic** - pass: no network ACL allows all traffic from `0.0.0.0/0`
  - **Console**:
    - Verify: VPC > Network ACLs > <acl> > Inbound rules > no rule with Type `All traffic`, Source `0.0.0.0/0` and Allow/Deny `Allow`
    - Fix: VPC > Network ACLs > select the ACL > Inbound rules > Edit inbound rules > Remove the blanket allow rule > Add new rule for each specific port and source > Save changes
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-network-acls \
        --query "NetworkAcls[].{id:NetworkAclId, open:Entries[?!Egress && CidrBlock=='0.0.0.0/0' && RuleAction=='allow' && Protocol=='-1'].RuleNumber}" \
        --output json
      ```
    - Expect: `open` is empty for every ACL. Network ACLs are the subnet-level backstop beneath security groups; a blanket allow removes that layer entirely.
    - Fix: `aws ec2 delete-network-acl-entry --network-acl-id <acl> --rule-number <n> --ingress`

- [ ] **Unrestricted Inbound Traffic on Remote Server Administration Ports** - pass: no network ACL allows 22 or 3389 from `0.0.0.0/0`
  - **Console**:
    - Verify: VPC > Network ACLs > <acl> > Inbound rules > no `Allow` rule with Source `0.0.0.0/0` whose `Port range` covers 22 or 3389 or reads `All`
    - Fix: VPC > Network ACLs > select the ACL > Inbound rules > Edit inbound rules > change the rule's Source to your administrative CIDR (or Remove it) > Save changes
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-network-acls \
        --query "NetworkAcls[].{id:NetworkAclId, entries:Entries[?!Egress && CidrBlock=='0.0.0.0/0' && RuleAction=='allow'].{rule:RuleNumber, from:PortRange.From, to:PortRange.To}}" \
        --output json
      ```
    - Expect: no allow entry whose port range covers 22 or 3389, and no entry with a null `PortRange` (which means all ports). SSM Session Manager needs no inbound access at all, so an open admin port is a choice, not a requirement.
    - Fix: `aws ec2 delete-network-acl-entry --network-acl-id <acl> --rule-number <n> --ingress`
    - Fix:
      ```bash
      aws ec2 create-network-acl-entry --network-acl-id <acl> --rule-number <n> --protocol tcp \
        --port-range From=22,To=22 --cidr-block <admin-cidr> --rule-action allow --ingress
      ```

- [ ] **VPC Endpoint Exposed** - pass: no VPC endpoint policy allows a wildcard principal
  - **Console**:
    - Verify: VPC > Endpoints > <endpoint> > Policy > no statement with `"Principal": "*"` lacks a `Condition` on `aws:PrincipalOrgID` or `aws:PrincipalAccount`
    - Fix: VPC > Endpoints > select the endpoint > Actions > Manage policy > `Custom` > paste a policy conditioned on `aws:PrincipalOrgID` > Save
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-vpc-endpoints \
        --query 'VpcEndpoints[].{id:VpcEndpointId, service:ServiceName, policy:PolicyDocument}' --output json
      ```
    - Expect: no `policy` grants `"Principal": "*"` without a condition restricting it to your account or Organization. A permissive endpoint policy lets principals outside your account reach the service through your network path.
    - Fix: `aws ec2 modify-vpc-endpoint --vpc-endpoint-id <id> --policy-document file://policy.json`

- [ ] **VPC Peering Connections To Accounts Outside AWS Organization** - pass: every peer account is in your Organization or documented
  - **Console**:
    - Verify: VPC > Peering connections > every value in the `Requester owner ID` and `Accepter owner ID` columns appears under Organizations > AWS accounts or maps to an approved partner
    - Fix: VPC > Peering connections > select the connection > Actions > Delete peering connection > check `Delete related route table entries` > Delete
  - **CLI**:
    - Verify:
      ```bash
      aws ec2 describe-vpc-peering-connections \
        --query 'VpcPeeringConnections[].{id:VpcPeeringConnectionId, requester:RequesterVpcInfo.OwnerId, accepter:AccepterVpcInfo.OwnerId, status:Status.Code}' \
        --output table
      ```
    - Verify: `aws organizations list-accounts --query 'Accounts[].Id' --output text`
    - Expect: every owner ID from the first command appears in the second command's output or maps to an approved partner. A peering connection is a routed network path, not an API grant - it bypasses most identity controls.
    - Fix: `aws ec2 delete-vpc-peering-connection --vpc-peering-connection-id <id>`

---

## Audit & Detection (CloudTrail)

- [ ] **CloudTrail Enabled** - pass: at least one multi-region trail is logging
  - **Console**:
    - Verify: CloudTrail > Trails > a trail shows `Multi-region trail` = `Yes` and `Status` = `Logging`
    - Fix: CloudTrail > Trails > Create trail > Trail name `org-trail` > check `Enable for all accounts in my organization` (from the management account) > Storage location = a new or existing S3 bucket > Next > Event type `Management events` > Next > Create trail
  - **CLI**:
    - Verify:
      ```bash
      aws cloudtrail describe-trails \
        --query 'trailList[].{name:Name, multiRegion:IsMultiRegionTrail, org:IsOrganizationTrail, bucket:S3BucketName}' --output table
      ```
    - Verify: `aws cloudtrail get-trail-status --name <trail> --query 'IsLogging'`
    - Expect: a trail with `multiRegion` = `True` exists and `IsLogging` is `true`. A single-region trail means activity in every other region is unrecorded, which is exactly where an attacker will operate.
    - Fix:
      ```bash
      aws cloudtrail create-trail --name org-trail --s3-bucket-name <bucket> --is-multi-region-trail \
        --is-organization-trail
      ```
    - Fix: `aws cloudtrail start-logging --name org-trail`

- [ ] **CloudTrail Global Services Enabled** - pass: `IncludeGlobalServiceEvents` = `true`
  - **Console**:
    - Verify: CloudTrail > Trails > <trail> > General details > `Multi-region trail` reads `Yes` (a multi-region trail always records global service events such as IAM, STS and CloudFront)
    - Fix: CloudTrail > Trails > <trail> > General details > Edit > enable the trail for all regions > Save changes
  - **CLI**:
    - Verify:
      ```bash
      aws cloudtrail describe-trails --query 'trailList[].{name:Name, global:IncludeGlobalServiceEvents}' --output table
      ```
    - Expect: `true` on your primary trail. Global service events cover IAM, STS and CloudFront - the control plane an attacker uses to establish persistence.
    - Fix: `aws cloudtrail update-trail --name <trail> --include-global-service-events`

- [ ] **CloudTrail Log File Integrity Validation** - pass: `LogFileValidationEnabled` = `true`
  - **Console**:
    - Verify: CloudTrail > Trails > <trail> > General details > `Log file validation` reads `Enabled`
    - Fix: CloudTrail > Trails > <trail> > General details > Edit > Additional settings > Log file validation `Enabled` > Save changes
  - **CLI**:
    - Verify:
      ```bash
      aws cloudtrail describe-trails --query 'trailList[].{name:Name, validation:LogFileValidationEnabled}' --output table
      ```
    - Expect: `true` on every trail. Without it you cannot prove logs were not altered after the fact, which undermines the evidence in exactly the incident where it matters.
    - Fix: `aws cloudtrail update-trail --name <trail> --enable-log-file-validation`
    - Fix: `aws cloudtrail validate-logs --trail-arn <arn> --start-time <time>`

- [ ] **CloudTrail Integrated With CloudWatch** - pass: `CloudWatchLogsLogGroupArn` is set and delivery is recent
  - **Console**:
    - Verify: CloudTrail > Trails > <trail> > CloudWatch Logs > `CloudWatch Logs` reads `Enabled` with a log group name, and `Last CloudWatch Logs delivery` shows a recent time with no delivery error
    - Fix: CloudTrail > Trails > <trail> > CloudWatch Logs > Edit > check `Enabled` > Log group = new or existing group > IAM role = new role > Save changes
  - **CLI**:
    - Verify:
      ```bash
      aws cloudtrail describe-trails --query 'trailList[].{name:Name, logGroup:CloudWatchLogsLogGroupArn}' --output table
      ```
    - Verify:
      ```bash
      aws cloudtrail get-trail-status --name <trail> \
        --query '{lastDelivery:LatestCloudWatchLogsDeliveryTime, error:LatestCloudWatchLogsDeliveryError}'
      ```
    - Expect: `logGroup` is populated, `lastDelivery` is recent, and `error` is null. Without CloudWatch integration there is nothing for metric filters to match, so none of the alarm controls in this guide can function.
    - Fix:
      ```bash
      aws cloudtrail update-trail --name <trail> --cloud-watch-logs-log-group-arn <arn> \
        --cloud-watch-logs-role-arn <role-arn>
      ```

- [ ] **CloudTrail Management Events** - pass: management events are recorded for both read and write
  - **Console**:
    - Verify: CloudTrail > Trails > <trail> > Management events > `API activity` reads `Read, Write`
    - Fix: CloudTrail > Trails > <trail> > Management events > Edit > check both `Read` and `Write` > Save changes
  - **CLI**:
    - Verify:
      ```bash
      aws cloudtrail get-event-selectors --trail-name <trail> \
        --query '{selectors:EventSelectors, advanced:AdvancedEventSelectors}' --output json
      ```
    - Expect: a selector with `IncludeManagementEvents` = `true` and `ReadWriteType` = `All`. `WriteOnly` omits the reconnaissance phase - the `Describe`, `List` and `Get` calls that show what an attacker looked at before acting.
    - Fix:
      ```bash
      aws cloudtrail put-event-selectors --trail-name <trail> \
        --event-selectors '[{"ReadWriteType":"All","IncludeManagementEvents":true}]'
      ```

---

## Databases (RDS)

- [ ] **RDS Publicly Accessible** - pass: `PubliclyAccessible` = `false` on every instance
  - **Console**:
    - Verify: RDS > Databases > <instance> > Connectivity & security > Security > `Publicly accessible` reads `No`
    - Fix: RDS > Databases > select the instance > Modify > Connectivity > Additional configuration > `Not publicly accessible` > Continue > Apply immediately > Modify DB instance
  - **CLI**:
    - Verify:
      ```bash
      aws rds describe-db-instances \
        --query 'DBInstances[].{id:DBInstanceIdentifier, public:PubliclyAccessible, endpoint:Endpoint.Address}' --output table
      ```
    - Expect: `public` is `False` everywhere. When true, the instance gets a publicly resolvable endpoint and is reachable from the internet subject only to its security group - one permissive rule from full exposure.
    - Fix:
      ```bash
      aws rds modify-db-instance --db-instance-identifier <id> --no-publicly-accessible \
        --apply-immediately
      ```

- [ ] **RDS Instance Not In Public Subnet** - pass: every DB subnet group contains only private subnets
  - **Console**:
    - Verify: RDS > Databases > <instance> > Connectivity & security > Networking > note every ID under `Subnets`; then VPC > Subnets > each subnet > Route table > Routes > no `0.0.0.0/0` route with an `igw-` target
    - Fix: RDS > Subnet groups > Create DB subnet group > choose only private subnets > Create; then RDS > Databases > select the instance > Modify > Connectivity > DB subnet group = the new group > Continue > Modify DB instance
  - **CLI**:
    - Verify:
      ```bash
      aws rds describe-db-instances \
        --query 'DBInstances[].{id:DBInstanceIdentifier, subnets:DBSubnetGroup.Subnets[].SubnetIdentifier}' --output json
      ```
    - Verify:
      ```bash
      aws ec2 describe-route-tables --filters Name=association.subnet-id,Values=<subnet> \
        --query 'RouteTables[].Routes[?GatewayId!=null].GatewayId'
      ```
    - Expect: the second command returns no `igw-` entry for any subnet listed by the first. A private subnet is the layer that holds when `PubliclyAccessible` is flipped by mistake.
    - Fix:
      ```bash
      aws rds create-db-subnet-group --db-subnet-group-name <group> \
        --db-subnet-group-description "private subnets" --subnet-ids <private-subnet-ids>
      ```
    - Fix: `aws rds modify-db-instance --db-instance-identifier <id> --db-subnet-group-name <group>`

- [ ] **Amazon RDS Public Snapshots** - pass: no manual snapshot is shared with `all`
  - **Console**:
    - Verify: RDS > Snapshots > Manual > select each snapshot > Actions > Share snapshot > `DB snapshot visibility` reads `Private`
    - Fix: RDS > Snapshots > Manual > select the snapshot > Actions > Share snapshot > DB snapshot visibility `Private` > Save
  - **CLI**:
    - Verify:
      ```bash
      aws rds describe-db-snapshots --snapshot-type manual --query 'DBSnapshots[].DBSnapshotIdentifier' --output text | tr '\t' '\n' | while read s; do
        a=$(aws rds describe-db-snapshot-attributes --db-snapshot-identifier "$s" \
          --query "DBSnapshotAttributesResult.DBSnapshotAttributes[?AttributeName=='restore'].AttributeValues" --output text)
        echo "$s: ${a:-none}"
      done
      ```
    - Expect: no snapshot lists `all`. A public snapshot can be restored by anyone into their own account - it is a full copy of your database, and the exposure is silent.
    - Fix:
      ```bash
      aws rds modify-db-snapshot-attribute --db-snapshot-identifier <snapshot> --attribute-name restore \
        --values-to-remove all
      ```

- [ ] **IAM Database Authentication** - pass: `IAMDatabaseAuthenticationEnabled` = `true` on MySQL and PostgreSQL instances
  - **Console**:
    - Verify: RDS > Databases > <instance> > Configuration > `IAM DB authentication` reads `Enabled`
    - Fix: RDS > Databases > select the instance > Modify > Database authentication > `Password and IAM database authentication` > Continue > Apply immediately > Modify DB instance
  - **CLI**:
    - Verify:
      ```bash
      aws rds describe-db-instances \
        --query "DBInstances[?Engine=='mysql' || Engine=='postgres'].{id:DBInstanceIdentifier, iamAuth:IAMDatabaseAuthenticationEnabled}" \
        --output table
      ```
    - Expect: `iamAuth` is `True`. Otherwise access depends on database passwords that are shared, rarely rotated, and invisible to your IAM offboarding process.
    - Fix:
      ```bash
      aws rds modify-db-instance --db-instance-identifier <id> --enable-iam-database-authentication \
        --apply-immediately
      ```

- [ ] **Unrestricted DB Security Group** - pass: no DB security group allows `0.0.0.0/0`
  - **Console**:
    - Verify: RDS > Databases > <instance> > Connectivity & security > Security > open each group under `VPC security groups` > Inbound rules > no rule with Source `0.0.0.0/0` or `::/0`
    - Fix: EC2 > Security Groups > select the group > Inbound rules > Edit inbound rules > Delete the `0.0.0.0/0` rule > Add rule > the database port > Source = the application tier's security group > Save rules
  - **CLI**:
    - Verify:
      ```bash
      aws rds describe-db-instances \
        --query 'DBInstances[].{id:DBInstanceIdentifier, sgs:VpcSecurityGroups[].VpcSecurityGroupId}' --output json
      ```
    - Verify:
      ```bash
      aws ec2 describe-security-groups --group-ids <sg> \
        --query "SecurityGroups[].IpPermissions[?IpRanges[?CidrIp=='0.0.0.0/0']]"
      ```
    - Expect: the second command returns an empty list for every group attached to a database (EC2-Classic `describe-db-security-groups` no longer applies to VPC instances - the VPC security group is the control). A database port open to the world is one leaked password from full disclosure.
    - Fix:
      ```bash
      aws ec2 revoke-security-group-ingress --group-id <sg> --protocol tcp --port <db-port> \
        --cidr 0.0.0.0/0
      ```
    - Fix:
      ```bash
      aws ec2 authorize-security-group-ingress --group-id <sg> --protocol tcp --port <db-port> \
        --source-group <app-sg>
      ```

- [ ] **RDS Auto Minor Version Upgrade** - pass: `AutoMinorVersionUpgrade` = `true`
  - **Console**:
    - Verify: RDS > Databases > <instance> > Maintenance & backups > Maintenance > `Auto minor version upgrade` reads `Enabled`
    - Fix: RDS > Databases > select the instance > Modify > Maintenance > check `Enable auto minor version upgrade` > choose a maintenance window you can tolerate > Continue > Modify DB instance
  - **CLI**:
    - Verify:
      ```bash
      aws rds describe-db-instances \
        --query 'DBInstances[].{id:DBInstanceIdentifier, autoUpgrade:AutoMinorVersionUpgrade, version:EngineVersion}' --output table
      ```
    - Expect: `autoUpgrade` is `True` on every instance. Minor versions are where database CVE fixes ship; without this the instance stays vulnerable until someone schedules a manual upgrade.
    - Fix:
      ```bash
      aws rds modify-db-instance --db-instance-identifier <id> --auto-minor-version-upgrade \
        --apply-immediately
      ```

- [ ] **RDS Master Username** - pass: no instance uses a default master username
  - **Console**:
    - Verify: RDS > Databases > <instance> > Configuration > `Master username` is not `admin`, `root`, `postgres`, `sa` or `awsuser`
    - Fix: RDS > Databases > Create database > Settings > Credentials settings > `Master username` = an unguessable name > Create database; then migrate applications to the new instance and delete the old one (the master username cannot be changed in place)
  - **CLI**:
    - Verify:
      ```bash
      aws rds describe-db-instances --query 'DBInstances[].{id:DBInstanceIdentifier, master:MasterUsername}' --output table
      ```
    - Expect: no instance uses `admin`, `root`, `postgres`, `sa` or `awsuser`. A predictable username halves the work of a credential-stuffing attempt.
    - Fix:
      ```bash
      aws rds create-db-instance --db-instance-identifier <new-id> --engine <engine> --db-instance-class <class> \
        --allocated-storage <gb> --master-username <unguessable-name> --manage-master-user-password \
        --db-subnet-group-name <group> --vpc-security-group-ids <sg> --no-publicly-accessible
      ```

---

## Serverless (Lambda)

- [ ] **Function Exposed** - pass: no resource policy allows a wildcard principal without a source condition
  - **Console**:
    - Verify: Lambda > Functions > <fn> > Configuration > Permissions > Resource-based policy statements > no statement with Principal `*` lacks a `Source ARN` or `Source account` condition
    - Fix: Lambda > Functions > <fn> > Configuration > Permissions > Resource-based policy statements > select the statement > Delete > Delete; then Add permissions > AWS service > choose the service > set `Source ARN` > Save
  - **CLI**:
    - Verify:
      ```bash
      aws lambda list-functions --query 'Functions[].FunctionName' --output text | tr '\t' '\n' | while read f; do
        p=$(aws lambda get-policy --function-name "$f" --query Policy --output text 2>/dev/null)
        echo "$p" | grep -q '"\*"' && echo "wildcard principal: $f"
      done
      ```
    - Expect: no output, or every wildcard is paired with a `Condition` on `AWS:SourceArn` or `AWS:SourceAccount`. An unconditioned wildcard lets any AWS principal invoke the function.
    - Fix: `aws lambda remove-permission --function-name <fn> --statement-id <sid>`
    - Fix:
      ```bash
      aws lambda add-permission --function-name <fn> --statement-id <sid> --action lambda:InvokeFunction \
        --principal <service> --source-arn <arn>
      ```

- [ ] **Lambda Function With Admin Privileges** - pass: no execution role holds AdministratorAccess or a wildcard policy
  - **Console**:
    - Verify: Lambda > Functions > <fn> > Configuration > Permissions > Execution role > open the role link > IAM > Roles > <role> > Permissions > Permissions policies > no `AdministratorAccess` and no inline policy allowing `"Action": "*"` on `"Resource": "*"`
    - Fix: IAM > Roles > <role> > Permissions > Permissions policies > select AdministratorAccess > Remove > Remove; then Add permissions > Create inline policy > JSON > only the APIs the handler calls > Next > Create policy
  - **CLI**:
    - Verify:
      ```bash
      aws lambda list-functions --query 'Functions[].{fn:FunctionName, role:Role}' --output text | while read fn role; do
        r=${role##*/}
        p=$(aws iam list-attached-role-policies --role-name "$r" \
          --query "AttachedPolicies[?PolicyName=='AdministratorAccess'].PolicyName" --output text)
        [ -n "$p" ] && echo "$fn ($r)"
      done
      ```
    - Expect: no output. A function's role is available to any code in that function, including a compromised dependency - admin on the role is admin for the whole supply chain.
    - Fix:
      ```bash
      aws iam detach-role-policy --role-name <role> \
        --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
      ```

- [ ] **Lambda Functions Should not Share Roles that Contain Admin Privileges** - pass: no execution role is shared across functions
  - **Console**:
    - Verify: Lambda > Functions > <fn> > Configuration > Permissions > Execution role > the `Role name` is unique to this function (no other function's Permissions page lists the same role)
    - Fix: IAM > Roles > Create role > Trusted entity type `AWS service` > Use case `Lambda` > Next > attach a policy scoped to this function > Next > Role name `<fn>-role` > Create role; then Lambda > Functions > <fn> > Configuration > Permissions > Execution role > Edit > `Use an existing role` > the new role > Save
  - **CLI**:
    - Verify:
      ```bash
      aws lambda list-functions --query 'Functions[].Role' --output text | tr '\t' '\n' | sort | uniq -c | sort -rn | awk '$1 > 1'
      ```
    - Expect: no output. A shared role means the least-trusted function determines the blast radius of every function sharing it, and least privilege becomes impossible to express.
    - Fix: `aws iam create-role --role-name <fn>-role --assume-role-policy-document file://lambda-trust.json`
    - Fix: `aws lambda update-function-configuration --function-name <fn> --role <new-role-arn>`

- [ ] **Lambda Cross Account Access** - pass: every external account in a function policy is known and approved
  - **Console**:
    - Verify: Lambda > Functions > <fn> > Configuration > Permissions > Resource-based policy statements > every principal account ID is your own or a documented partner
    - Fix: Lambda > Functions > <fn> > Configuration > Permissions > Resource-based policy statements > select the stale statement > Delete > Delete
  - **CLI**:
    - Verify:
      ```bash
      aws lambda list-functions --query 'Functions[].FunctionName' --output text | tr '\t' '\n' | while read f; do
        p=$(aws lambda get-policy --function-name "$f" --query Policy --output text 2>/dev/null)
        [ -n "$p" ] && echo "$p" | grep -oE '[0-9]{12}' | sort -u | sed "s|^|$f: |"
      done
      ```
    - Expect: every account ID is your own or a documented partner. Cross-account invoke rights persist long after the integration that needed them.
    - Fix: `aws lambda remove-permission --function-name <fn> --statement-id <sid>`

- [ ] **Enable IAM Authentication for Lambda Function URLs** - pass: no function URL uses `AuthType` `NONE`
  - **Console**:
    - Verify: Lambda > Functions > <fn> > Configuration > Function URL > `Auth type` reads `AWS_IAM` (or no function URL is configured)
    - Fix: Lambda > Functions > <fn> > Configuration > Function URL > Edit > Auth type `AWS_IAM` > Save (or Delete > Delete to remove the URL and route through API Gateway with a WAF)
  - **CLI**:
    - Verify:
      ```bash
      aws lambda list-functions --query 'Functions[].FunctionName' --output text | tr '\t' '\n' | while read f; do
        aws lambda list-function-url-configs --function-name "$f" \
          --query "FunctionUrlConfigs[].{fn:'$f', auth:AuthType}" --output text 2>/dev/null
      done
      ```
    - Verify:
      ```bash
      aws lambda list-function-url-configs --function-name <fn> \
        --query 'FunctionUrlConfigs[].{url:FunctionUrl, auth:AuthType}' --output table
      ```
    - Expect: no row shows `NONE`. `AuthType: NONE` publishes an unauthenticated HTTPS endpoint straight to the internet, with no WAF and no API Gateway in front of it.
    - Fix: `aws lambda update-function-url-config --function-name <fn> --auth-type AWS_IAM`
    - Fix: `aws lambda delete-function-url-config --function-name <fn>`

- [ ] **Lambda Using Supported Runtime Environment** - pass: no function runs a deprecated runtime
  - **Console**:
    - Verify: Lambda > Functions > <fn> > Code > Runtime settings > `Runtime` is on the current AWS supported list and no deprecation banner is shown at the top of the function page
    - Fix: Lambda > Functions > <fn> > Code > Runtime settings > Edit > Runtime = a supported version > Save; then redeploy the code after testing for breaking language changes
  - **CLI**:
    - Verify:
      ```bash
      aws lambda list-functions --query 'Functions[].{fn:FunctionName, runtime:Runtime}' --output table | sort -k2
      ```
    - Expect: every runtime is on the current AWS supported list. A deprecated runtime stops receiving security patches, and AWS eventually blocks updates to the function entirely.
    - Fix: `aws lambda update-function-configuration --function-name <fn> --runtime <supported-runtime>`

- [ ] **VPC Access for AWS Lambda Functions** - pass: functions reaching private resources have a `VpcConfig`
  - **Console**:
    - Verify: Lambda > Functions > <fn> > Configuration > VPC > `VPC` shows a VPC ID with private subnets and a security group for every function that touches a database, cache or internal service
    - Fix: Lambda > Functions > <fn> > Configuration > VPC > Edit > VPC = the workload VPC > Subnets = private subnets > Security groups = the function's group > Save
  - **CLI**:
    - Verify:
      ```bash
      aws lambda list-functions \
        --query 'Functions[].{fn:FunctionName, vpc:VpcConfig.VpcId, subnets:length(VpcConfig.SubnetIds || [])}' --output table
      ```
    - Expect: every function that touches a database, cache or internal service has a `vpc` set. A function outside a VPC reaches those resources only if they are publicly exposed - so a null here often means something else is open.
    - Fix:
      ```bash
      aws lambda update-function-configuration --function-name <fn> \
        --vpc-config SubnetIds=<subnet-ids>,SecurityGroupIds=<sg-ids>
      ```

---

## Encryption Keys (KMS)

- [ ] **Key Exposed** - pass: no key policy allows a wildcard principal without a condition
  - **Console**:
    - Verify: KMS > Customer managed keys > <key> > Key policy > Switch to policy view > no statement with `"AWS": "*"` lacks a `Condition` on `kms:CallerAccount` or `aws:PrincipalOrgID`
    - Fix: KMS > Customer managed keys > <key> > Key policy > Switch to policy view > Edit > replace the wildcard principal with the role ARNs that need `Encrypt`, `Decrypt` or `GenerateDataKey` > Save changes
  - **CLI**:
    - Verify:
      ```bash
      aws kms list-keys --query 'Keys[].KeyId' --output text | tr '\t' '\n' | while read k; do
        m=$(aws kms describe-key --key-id "$k" --query 'KeyMetadata.KeyManager' --output text)
        [ "$m" = "CUSTOMER" ] || continue
        aws kms get-key-policy --key-id "$k" --policy-name default --query Policy --output text | \
          grep -q '"AWS": "\*"' && echo "wildcard: $k"
      done
      ```
    - Expect: no output, or every wildcard principal is constrained by a `Condition` on `kms:CallerAccount` or `aws:PrincipalOrgID`. An open key policy makes the encryption decorative - anyone who can reach the ciphertext can also call `Decrypt`.
    - Fix: `aws kms put-key-policy --key-id <key> --policy-name default --policy file://policy.json`

- [ ] **KMS Cross Account Access** - pass: every external account in a key policy is known and approved
  - **Console**:
    - Verify: KMS > Customer managed keys > <key> > Other AWS accounts > every listed account ID is a documented partner, and Key policy > every principal ARN belongs to your own account or a documented partner
    - Fix: KMS > Customer managed keys > <key> > Other AWS accounts > Change other AWS accounts > Remove next to the stale account > Save changes
  - **CLI**:
    - Verify:
      ```bash
      aws kms list-keys --query 'Keys[].KeyId' --output text | tr '\t' '\n' | while read k; do
        aws kms get-key-policy --key-id "$k" --policy-name default --query Policy --output text 2>/dev/null | \
          grep -oE 'arn:aws:iam::[0-9]{12}' | sort -u | sed "s|^|$k: |"
      done
      ```
    - Verify: `aws kms list-grants --key-id <key> --query 'Grants[].[GranteePrincipal,Operations]' --output table`
    - Expect: every account ID is your own or a documented partner, and every grant names a principal you recognise (grants do not appear in the policy). Cross-account decrypt rights are equivalent to handing over the data the key protects.
    - Fix: `aws kms put-key-policy --key-id <key> --policy-name default --policy file://policy.json`
    - Fix: `aws kms revoke-grant --key-id <key> --grant-id <id>`

---

## Kubernetes (EKS)

- [ ] **EKS Cluster Endpoint Public Access** - pass: `endpointPublicAccess` = `false`, or restricted by CIDR
  - **Console**:
    - Verify: EKS > Clusters > <cluster> > Networking > `API server endpoint access` reads `Private`, or `Public and private` with a `Public access source allowlist` that does not contain `0.0.0.0/0`
    - Fix: EKS > Clusters > <cluster> > Networking > Manage endpoint access > `Private` (or `Public and private` with Advanced settings > allowlist = office, VPN and CI egress CIDRs) > Save changes
  - **CLI**:
    - Verify:
      ```bash
      aws eks list-clusters --query 'clusters' --output text | tr '\t' '\n' | while read c; do
        aws eks describe-cluster --name "$c" \
          --query "cluster.{name:name, public:resourcesVpcConfig.endpointPublicAccess, private:resourcesVpcConfig.endpointPrivateAccess, cidrs:resourcesVpcConfig.publicAccessCidrs}" \
          --output json
      done
      ```
    - Expect: `public` is `false`, or `true` with `cidrs` containing no `0.0.0.0/0`. A public API server with the default CIDR accepts authentication attempts from anywhere.
    - Fix:
      ```bash
      aws eks update-cluster-config --name <cluster> \
        --resources-vpc-config endpointPublicAccess=false,endpointPrivateAccess=true
      ```
    - Fix:
      ```bash
      aws eks update-cluster-config --name <cluster> \
        --resources-vpc-config endpointPublicAccess=true,endpointPrivateAccess=true,publicAccessCidrs=<office-cidr>,<vpn-cidr>,<ci-egress-ip>/32
      ```

- [ ] **Ensure EKS Clusters Have Private Endpoint Enabled and Public Access Disabled** - pass: `endpointPrivateAccess` = `true` and `endpointPublicAccess` = `false`
  - **Console**:
    - Verify: EKS > Clusters > <cluster> > Networking > `API server endpoint access` reads `Private`
    - Fix: EKS > Clusters > <cluster> > Networking > Manage endpoint access > `Private` > Save changes (confirm your CI has a network path into the VPC first)
  - **CLI**:
    - Verify:
      ```bash
      aws eks list-clusters --query 'clusters' --output text | tr '\t' '\n' | while read c; do
        echo "$c: $(aws eks describe-cluster --name "$c" --query 'cluster.resourcesVpcConfig.[endpointPrivateAccess,endpointPublicAccess]' --output text)"
      done
      ```
    - Expect: `True False` for every production cluster. Private-only access means the API server is reachable solely from inside the VPC or over a connected network.
    - Fix:
      ```bash
      aws eks update-cluster-config --name <cluster> \
        --resources-vpc-config endpointPrivateAccess=true,endpointPublicAccess=false
      ```

- [ ] **Ensure EKS Clusters Are Created with Private Nodes** - pass: node group subnets have no route to an internet gateway
  - **Console**:
    - Verify: EKS > Clusters > <cluster> > Compute > Node groups > <group> > Details > note every ID under `Subnets`; then VPC > Subnets > each subnet > Route table > Routes > no `0.0.0.0/0` route with an `igw-` target
    - Fix: EKS > Clusters > <cluster> > Compute > Add node group > Node group configuration > Next > Node group network configuration > Subnets = private subnets only > Next > Create; then drain the old group and EKS > Clusters > <cluster> > Compute > Node groups > select the old group > Delete > type its name > Delete
  - **CLI**:
    - Verify:
      ```bash
      aws eks list-clusters --query 'clusters' --output text | tr '\t' '\n' | while read c; do
        for g in $(aws eks list-nodegroups --cluster-name "$c" --query 'nodegroups' --output text); do
          echo "== $c/$g"
          aws eks describe-nodegroup --cluster-name "$c" --nodegroup-name "$g" --query 'nodegroup.subnets' --output text
        done
      done
      ```
    - Verify:
      ```bash
      aws ec2 describe-route-tables --filters Name=association.subnet-id,Values=<subnet> \
        --query 'RouteTables[].Routes[].[DestinationCidrBlock,GatewayId]' --output table
      ```
    - Expect: for every subnet the first command lists, the second command shows no `0.0.0.0/0` route paired with an `igw-` gateway. Nodes with public addresses expose the kubelet and every hostNetwork pod.
    - Fix:
      ```bash
      aws eks create-nodegroup --cluster-name <cluster> --nodegroup-name <new-group> \
        --subnets <private-subnet-ids> --node-role <node-role-arn>
      ```
    - Fix: `aws eks delete-nodegroup --cluster-name <cluster> --nodegroup-name <old-group>`

- [ ] **Disable Remote Access to EKS Cluster Node Groups** - pass: no node group has a `remoteAccess` SSH key configured
  - **Console**:
    - Verify: EKS > Clusters > <cluster> > Compute > Node groups > <group> > Details > Node group configuration > `SSH key pair` shows no key
    - Fix: EKS > Clusters > <cluster> > Compute > Add node group > Node group configuration > Next > Node group network configuration > leave `Configure remote access to nodes` off > Next > Create; then drain the old group and EKS > Clusters > <cluster> > Compute > Node groups > select the old group > Delete > type its name > Delete
  - **CLI**:
    - Verify:
      ```bash
      aws eks list-clusters --query 'clusters' --output text | tr '\t' '\n' | while read c; do
        for g in $(aws eks list-nodegroups --cluster-name "$c" --query 'nodegroups' --output text); do
          echo "$c/$g: $(aws eks describe-nodegroup --cluster-name "$c" --nodegroup-name "$g" --query 'nodegroup.remoteAccess' --output json | tr -d '\n')"
        done
      done
      ```
    - Expect: `remoteAccess` is `null` for every node group. A configured SSH key is a standing path onto the node that bypasses Kubernetes authorization entirely; use SSM Session Manager for the rare cases where node access is genuinely needed.
    - Fix:
      ```bash
      aws eks create-nodegroup --cluster-name <cluster> --nodegroup-name <new-group> \
        --subnets <private-subnet-ids> --node-role <node-role-arn>
      ```
    - Fix: `aws eks delete-nodegroup --cluster-name <cluster> --nodegroup-name <old-group>`

- [ ] **Enable Envelope Encryption for EKS Kubernetes Secrets** - pass: an `encryptionConfig` with a KMS key covering `secrets`
  - **Console**:
    - Verify: EKS > Clusters > <cluster> > Overview > `Secrets encryption` reads `Enabled` with a customer-managed KMS key ARN
    - Fix: EKS > Clusters > <cluster> > Overview > Secrets encryption > Enable > KMS key = a customer-managed key > Enable (this is one-way and cannot be removed afterwards)
  - **CLI**:
    - Verify:
      ```bash
      aws eks list-clusters --query 'clusters' --output text | tr '\t' '\n' | while read c; do
        echo "$c: $(aws eks describe-cluster --name "$c" --query 'cluster.encryptionConfig' --output json | tr -d '\n')"
      done
      ```
    - Expect: each cluster returns a config with `resources: ["secrets"]` and a customer-managed KMS key ARN. Without it, Kubernetes secrets sit in etcd protected only by platform keys you cannot rotate or revoke.
    - Fix:
      ```bash
      aws eks associate-encryption-config --cluster-name <cluster> \
        --encryption-config '[{"resources":["secrets"],"provider":{"keyArn":"<kms-key-arn>"}}]'
      ```

- [ ] **Enable Support for Network Policies** - pass: a network policy engine is installed and default-deny policies exist
  - **Console**:
    - Verify: EKS > Clusters > <cluster> > Add-ons > `Amazon VPC CNI` > Configuration values contain `"enableNetworkPolicy": "true"` (or a Calico/Cilium add-on is installed), and EKS > Clusters > <cluster> > Resources > Policy > NetworkPolicies > a default-deny policy is listed in every namespace
    - Fix: EKS > Clusters > <cluster> > Add-ons > Amazon VPC CNI > Edit > Optional configuration settings > Configuration values `{"enableNetworkPolicy":"true"}` > Save changes; then apply a default-deny `NetworkPolicy` per namespace and allow-list the flows you need
  - **CLI**:
    - Verify:
      ```bash
      aws eks list-clusters --query 'clusters' --output text | tr '\t' '\n' | while read c; do
        echo "== $c"
        aws eks list-addons --cluster-name "$c" --query 'addons' --output text
      done
      ```
    - Verify: `kubectl get networkpolicy --all-namespaces`
    - Expect: the VPC CNI addon has network policy enabled (or Calico/Cilium is installed) and each namespace has a default-deny policy. An engine with no policies enforces nothing - every pod still reaches every other pod.
    - Fix:
      ```bash
      aws eks update-addon --cluster-name <cluster> --addon-name vpc-cni \
        --configuration-values '{"enableNetworkPolicy":"true"}'
      ```
    - Fix: `kubectl apply -n <namespace> -f default-deny.yaml`

- [ ] **Kubernetes Cluster Logging** - pass: all five control plane log types are enabled
  - **Console**:
    - Verify: EKS > Clusters > <cluster> > Observability > Control plane logs > `API server`, `Audit`, `Authenticator`, `Controller manager` and `Scheduler` all read `On`
    - Fix: EKS > Clusters > <cluster> > Observability > Control plane logs > Manage logging > turn on all five log types > Save changes
  - **CLI**:
    - Verify:
      ```bash
      aws eks list-clusters --query 'clusters' --output text | tr '\t' '\n' | while read c; do
        echo "$c: $(aws eks describe-cluster --name "$c" --query 'cluster.logging.clusterLogging' --output json | tr -d '\n')"
      done
      ```
    - Expect: `api`, `audit`, `authenticator`, `controllerManager` and `scheduler` all appear with `enabled: true`. The `audit` log in particular is the only record of who called the Kubernetes API.
    - Fix:
      ```bash
      aws eks update-cluster-config --name <cluster> \
        --logging '{"clusterLogging":[{"types":["api","audit","authenticator","controllerManager","scheduler"],"enabled":true}]}'
      ```

- [ ] **Kubernetes Cluster Version** - pass: every cluster runs a version still in standard support
  - **Console**:
    - Verify: EKS > Clusters > <cluster> > Overview > `Kubernetes version` is within the AWS standard support window and no extended-support notice is shown
    - Fix: EKS > Clusters > <cluster> > Overview > Upgrade version > select the next minor version > Update; then update node groups and add-ons to match
  - **CLI**:
    - Verify:
      ```bash
      aws eks list-clusters --query 'clusters' --output text | tr '\t' '\n' | while read c; do
        echo "$c: $(aws eks describe-cluster --name "$c" --query 'cluster.version' --output text)"
      done
      ```
    - Expect: each version is within the AWS standard support window. Extended support costs more and ends; past that, the control plane stops receiving security patches.
    - Fix: `aws eks update-cluster-version --name <cluster> --kubernetes-version <version>`

- [ ] **Use OIDC Provider for Authenticating Kubernetes API Calls** - pass: an IAM OIDC provider exists for the cluster issuer
  - **Console**:
    - Verify: EKS > Clusters > <cluster> > Overview > note the `OpenID Connect provider URL`; then IAM > Identity providers > a provider of type `OpenID Connect` whose URL matches that issuer is listed
    - Fix: IAM > Identity providers > Add provider > `OpenID Connect` > Provider URL = the cluster's OpenID Connect provider URL > Audience `sts.amazonaws.com` > Add provider; then move workloads to IRSA or EKS Pod Identity
  - **CLI**:
    - Verify:
      ```bash
      aws eks list-clusters --query 'clusters' --output text | tr '\t' '\n' | while read c; do
        iss=$(aws eks describe-cluster --name "$c" --query 'cluster.identity.oidc.issuer' --output text)
        echo "$c: $iss"
      done
      ```
    - Verify: `aws iam list-open-id-connect-providers`
    - Expect: each cluster's issuer URL has a matching IAM OIDC provider. Without it, pods cannot use IAM roles for service accounts and fall back to the node instance role - every pod on the node inherits the same permissions.
    - Fix: `eksctl utils associate-iam-oidc-provider --cluster <cluster> --approve`
    - Fix: `aws iam create-open-id-connect-provider --url <issuer> --client-id-list sts.amazonaws.com`

---

## Secrets Management

- [ ] **AWS Secrets Manager in Use for RDS Instances** - pass: every RDS master credential is stored in Secrets Manager
  - **Console**:
    - Verify: RDS > Databases > <instance> > Configuration > `Master credentials ARN` shows a Secrets Manager secret (or Secrets Manager > Secrets lists a documented secret for that database)
    - Fix: RDS > Databases > select the instance > Modify > Settings > Credentials management > check `Manage master credentials in AWS Secrets Manager` > Continue > Apply immediately > Modify DB instance
  - **CLI**:
    - Verify:
      ```bash
      aws secretsmanager list-secrets \
        --query 'SecretList[].{name:Name, rotation:RotationEnabled, lastRotated:LastRotatedDate}' --output table
      ```
    - Verify:
      ```bash
      aws rds describe-db-instances \
        --query 'DBInstances[].{id:DBInstanceIdentifier, managedSecret:MasterUserSecret.SecretArn}' --output table
      ```
    - Expect: every database has a corresponding secret - either a managed `MasterUserSecret` or a documented Secrets Manager entry. Credentials outside it usually live in application config, CI variables or a shared password manager where rotation never happens.
    - Fix:
      ```bash
      aws rds modify-db-instance --db-instance-identifier <id> --manage-master-user-password \
        --apply-immediately
      ```

- [ ] **Secret Rotation Enabled** - pass: `RotationEnabled` = `true` on every secret
  - **Console**:
    - Verify: Secrets Manager > Secrets > <secret> > Rotation configuration > `Rotation status` reads `Enabled` with a schedule
    - Fix: Secrets Manager > Secrets > <secret> > Rotation configuration > Edit rotation > turn on `Automatic rotation` > Rotation schedule every 30 days > Rotation function = the rotation Lambda > Save
  - **CLI**:
    - Verify:
      ```bash
      aws secretsmanager list-secrets \
        --query "SecretList[?!RotationEnabled].{name:Name, created:CreatedDate}" --output table
      ```
    - Expect: no rows. A secret that never rotates has the same value it had the day someone copied it into a notebook, and a leak stays exploitable indefinitely.
    - Fix:
      ```bash
      aws secretsmanager rotate-secret --secret-id <secret> --rotation-lambda-arn <arn> \
        --rotation-rules AutomaticallyAfterDays=30
      ```
