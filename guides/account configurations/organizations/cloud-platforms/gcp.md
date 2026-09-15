<!--
id: gcp-cloud-security
type: CONFIGURATION
scope: ORGANIZATION
-->

<div align="center">
  <img src="../../../../images/guides/gcp.svg" alt="GCP Logo" width="64" height="64">
  <h2><a href="https://cloud.google.com/" target="_blank" rel="noopener noreferrer">GCP</a> Configuration Guide</h2>
  <p><em>Identity, Network, Data, and Detection controls for Google Cloud accounts</em></p>
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

- Google Cloud CLI - check with `gcloud version`. Some commands need the `beta` component: `gcloud components install beta`.
- Sign in and confirm your context:
  - `gcloud auth login`
  - `gcloud organizations list` and `gcloud projects list --format="table(projectId, name, lifecycleState)"`
  - `gcloud config set project <project-id>`
- **Most checks are per-project.** To sweep every project you can see, wrap the command:
  - `for p in $(gcloud projects list --format="value(projectId)"); do echo "== $p"; <command> --project="$p"; done`
- Organization-level items need the organization ID: `export ORG_ID=$(gcloud organizations list --format="value(ID)" | head -1)`
- A read-only principal is enough for every **Run** command: grant `roles/viewer` plus `roles/iam.securityReviewer` at the organization level.
- Identity items covering user accounts and 2-Step Verification are enforced in the **Google Workspace / Cloud Identity** admin console, not in `gcloud` - those are marked as console checks.

---

## Identity & Access (IAM)

- [ ] **Corporate Login Credentials In Use** - pass: no IAM member is a `gmail.com` or other non-corporate account
  - **Run**: `gcloud organizations get-iam-policy $ORG_ID --format="json" | grep -oE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+' | sort -u | grep -v "@<your-domain>"`
  - **Verify**: no personal accounts (`@gmail.com`, or any domain you do not control) appear. A personal account cannot be suspended, audited, or have its credentials reset by your administrators - when that person leaves, their access leaves with them only if someone remembers.
  - **Fix**: create a Cloud Identity account on your domain for the person, grant the binding to that identity, then `gcloud organizations remove-iam-policy-binding $ORG_ID --member="user:<personal>@gmail.com" --role="<role>"`. Enforce with the `constraints/iam.allowedPolicyMemberDomains` organization policy.

- [ ] **Delete Google Cloud API Keys** - pass: no API keys exist, or each is restricted by API and referrer
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud services api-keys list --project="$p" --format="table(displayName, restrictions.apiTargets[].service, restrictions.browserKeyRestrictions.allowedReferrers)" 2>/dev/null | sed "s|^|$p |"; done`
  - **Verify**: no keys, or every key has both an API restriction and an application restriction. An unrestricted API key works from anywhere for any enabled API, and keys are routinely shipped in client-side JavaScript and mobile binaries.
  - **Fix**: `gcloud services api-keys delete <key-id>` where unused. Where required, `gcloud services api-keys update <key-id> --api-target=service=<api> --allowed-referrers="<domain>"`. Prefer OAuth or service account authentication over API keys.

- [ ] **Delete User-Managed Service Account Keys** - pass: no `USER_MANAGED` keys exist
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do for sa in $(gcloud iam service-accounts list --project="$p" --format="value(email)"); do gcloud iam service-accounts keys list --iam-account="$sa" --managed-by=user --project="$p" --format="value(name, validAfterTime)" | sed "s|^|$p $sa |"; done; done`
  - **Verify**: no output. A user-managed key is a permanent credential in a JSON file - it gets committed to repositories, pasted into CI, and copied between laptops, and it does not expire.
  - **Fix**: `gcloud iam service-accounts keys delete <key-id> --iam-account=<sa>` after moving the workload to Workload Identity Federation (outside GCP) or an attached service account (inside GCP). Block new ones with the `constraints/iam.disableServiceAccountKeyCreation` policy.

- [ ] **Enable Multi-Factor Authentication for User Accounts** - pass: 2-Step Verification enforced for every user (console check)
  - **Run**: this is a Cloud Identity / Workspace setting with no `gcloud` equivalent. Check **admin.google.com > Security > Authentication > 2-Step Verification**, and review per-user enrolment under **Directory > Users > Security**. To list the accounts in scope: `gcloud identity groups memberships list --group-email="<group>@<your-domain>"`
  - **Verify**: **Allow users to turn on 2-Step Verification** is on and **Enforcement** is set to **On** for all organizational units, with a short new-user enrolment period. Without enforcement, MFA is opt-in and the accounts that skip it are the ones targeted.
  - **Fix**: admin.google.com > **Security > Authentication > 2-Step Verification** > set **Enforcement: On**, methods **Any except verification codes via text, phone call**. Exempt only a break-glass account, secured with a hardware key.

- [ ] **Enable Security Key Enforcement for Admin Accounts** - pass: security keys required for all privileged accounts (console check)
  - **Run**: list who holds organization-level privilege first - `gcloud organizations get-iam-policy $ORG_ID --format="table(bindings.role, bindings.members)" | grep -E "admin|owner|Owner|Admin"` - then check enforcement at **admin.google.com > Security > Authentication > 2-Step Verification**.
  - **Verify**: the enforcement method for the administrator organizational unit is **Only security key**. TOTP and push prompts are phishable in real time; a FIDO2 key is bound to the origin and is not.
  - **Fix**: place administrators in their own organizational unit, then set **2-Step Verification > Methods > Only security key** on that unit. Issue two keys per admin so a lost key is not a lockout.

- [ ] **Minimize the Use of Primitive Roles** - pass: no member holds `roles/owner`, `roles/editor` or `roles/viewer`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do echo "== $p"; gcloud projects get-iam-policy "$p" --flatten="bindings[].members" --format="table(bindings.role, bindings.members)" --filter="bindings.role:roles/owner OR bindings.role:roles/editor OR bindings.role:roles/viewer"; done`
  - **Verify**: no rows beyond documented break-glass owners. `roles/editor` alone grants write access to nearly every resource in the project, including the ability to grant itself more.
  - **Fix**: `gcloud projects remove-iam-policy-binding <project> --member="<member>" --role="roles/editor"` and re-grant the specific predefined role for the job. Use the Recommender to find the narrower role: `gcloud recommender recommendations list --recommender=google.iam.policy.Recommender --location=global --project=<project>`.

- [ ] **Restrict Administrator Access for Service Accounts** - pass: no service account holds an admin, owner or editor role
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud projects get-iam-policy "$p" --flatten="bindings[].members" --format="value(bindings.role, bindings.members)" --filter="bindings.members:serviceAccount AND (bindings.role:admin OR bindings.role:roles/owner OR bindings.role:roles/editor)" | sed "s|^|$p |"; done`
  - **Verify**: no output. A service account's credentials live wherever the workload runs, so admin on a service account is admin for anything that can read that workload's environment.
  - **Fix**: `gcloud projects remove-iam-policy-binding <project> --member="serviceAccount:<sa>" --role="<role>"` and grant only the specific permissions the workload calls.

- [ ] **Rotate User-Managed Service Account Keys** - pass: no user-managed key older than 90 days
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do for sa in $(gcloud iam service-accounts list --project="$p" --format="value(email)"); do gcloud iam service-accounts keys list --iam-account="$sa" --managed-by=user --project="$p" --format="table(name.basename(), validAfterTime, validBeforeTime)"; done; done`
  - **Verify**: every `validAfterTime` is within 90 days. This control is the fallback for keys you cannot yet eliminate - the durable answer is the control above.
  - **Fix**: create the replacement, deploy it, then `gcloud iam service-accounts keys delete <key-id> --iam-account=<sa>`. Cap key lifetime centrally with `constraints/iam.serviceAccountKeyExpiryHours`.

- [ ] **Detect GCP IAM Configuration Changes** - pass: a log-based metric and alert policy exist for IAM changes
  - **Run**: `gcloud logging metrics list --format="table(name, filter)"` and `gcloud alpha monitoring policies list --format="table(displayName, enabled)"`
  - **Verify**: a metric filtering `protoPayload.serviceName="iam.googleapis.com"` or `SetIamPolicy` exists, and an alert policy whose condition filter names that metric with `enabled` = `True`. A metric with no alert produces a chart nobody opens.
  - **Fix**: `gcloud logging metrics create iam-changes --description="IAM policy changes" --log-filter='protoPayload.methodName="SetIamPolicy" OR protoPayload.serviceName="iam.googleapis.com"'`, then create an alert policy on that metric with a notification channel that reaches a person.

---

## Storage (Cloud Storage)

- [ ] **Check for Publicly Accessible Cloud Storage Buckets** - pass: no bucket IAM policy grants `allUsers` or `allAuthenticatedUsers`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do for b in $(gcloud storage buckets list --project="$p" --format="value(name)"); do gcloud storage buckets get-iam-policy "gs://$b" --format="json" | grep -qE '"allUsers"|"allAuthenticatedUsers"' && echo "PUBLIC: $p $b"; done; done`
  - **Verify**: no output. `allUsers` is the open internet; `allAuthenticatedUsers` is every Google account holder, which is not meaningfully narrower.
  - **Fix**: `gcloud storage buckets remove-iam-policy-binding gs://<bucket> --member=allUsers --role=roles/storage.objectViewer`, then enable public access prevention so it cannot return.

- [ ] **Bucket Policies with Administrative Permissions** - pass: no bucket grants `roles/storage.admin` to a broad member
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do for b in $(gcloud storage buckets list --project="$p" --format="value(name)"); do gcloud storage buckets get-iam-policy "gs://$b" --format="value(bindings.role, bindings.members)" --flatten="bindings[].members" --filter="bindings.role:roles/storage.admin" | sed "s|^|$p $b |"; done; done`
  - **Verify**: only named administrative principals hold `storage.admin`. That role includes deleting the bucket and rewriting its IAM policy, so it covers destroying your evidence as well as reading your data.
  - **Fix**: `gcloud storage buckets remove-iam-policy-binding gs://<bucket> --member=<member> --role=roles/storage.admin` and re-grant `roles/storage.objectViewer` or `roles/storage.objectCreator`.

- [ ] **Enable Uniform Bucket-Level Access for Cloud Storage Buckets** - pass: `uniform_bucket_level_access` = `True`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud storage buckets list --project="$p" --format="table(name, uniform_bucket_level_access)"; done`
  - **Verify**: `True` on every bucket. With legacy ACLs active, a single object can be made public independently of the bucket policy, and object-level grants do not appear in any IAM review.
  - **Fix**: `gcloud storage buckets update gs://<bucket> --uniform-bucket-level-access`. Audit existing object ACLs first - they stop taking effect immediately.

- [ ] **Enforce Public Access Prevention** - pass: `publicAccessPrevention` = `enforced` on every bucket
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud storage buckets list --project="$p" --format="table(name, public_access_prevention)"; done`
  - **Verify**: `enforced` on every bucket. `inherited` means the bucket depends on an organization policy that a project owner can change; `enforced` blocks public grants at the bucket regardless.
  - **Fix**: `gcloud storage buckets update gs://<bucket> --public-access-prevention`, and set it organization-wide with the `constraints/storage.publicAccessPrevention` policy.

- [ ] **Enable Data Access Audit Logs** - pass: `DATA_READ` and `DATA_WRITE` logging enabled for all services
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do echo "== $p"; gcloud projects get-iam-policy "$p" --format="json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('auditConfigs','NONE'))"; done`
  - **Verify**: an `auditConfigs` entry for `allServices` with `DATA_READ`, `DATA_WRITE` and `ADMIN_READ`. Admin activity logs are on by default; data access logs are not, so without this there is no record of who read an object.
  - **Fix**: export the policy, add the audit config, and apply it: `gcloud projects set-iam-policy <project> policy.json` with `"auditConfigs":[{"service":"allServices","auditLogConfigs":[{"logType":"DATA_READ"},{"logType":"DATA_WRITE"},{"logType":"ADMIN_READ"}]}]`. Budget for the log volume before enabling everywhere.

- [ ] **Use VPC Service Controls for Cloud Storage Buckets** - pass: a service perimeter covers `storage.googleapis.com`
  - **Run**: `gcloud access-context-manager policies list --organization=$ORG_ID --format="value(name)"` then `gcloud access-context-manager perimeters list --policy=<policy-id> --format="table(title, status.restrictedServices)"`
  - **Verify**: a perimeter exists and lists `storage.googleapis.com` in `restrictedServices`. IAM alone cannot stop a valid credential being used from outside your network; a perimeter can. This is the control that blocks exfiltration by a credential that is genuinely authorised.
  - **Fix**: `gcloud access-context-manager perimeters create <name> --title=<title> --resources=projects/<number> --restricted-services=storage.googleapis.com --policy=<policy-id>`. Run in dry-run mode first - perimeters break legitimate access paths that nobody documented.

---

## Compute Engine

- [ ] **Check for Virtual Machine Instances with Public IP Addresses** - pass: no instance has an external NAT address
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud compute instances list --project="$p" --format="table(name, zone, networkInterfaces[0].accessConfigs[0].natIP)" --filter="networkInterfaces[0].accessConfigs[0].natIP:*"; done`
  - **Verify**: no rows, except instances that must terminate inbound traffic. Every external IP is an internet-facing attack surface that firewall rules alone have to hold back.
  - **Fix**: `gcloud compute instances delete-access-config <instance> --access-config-name="external-nat" --zone=<zone>`, add Cloud NAT for egress, and use IAP TCP forwarding for administrative access.

- [ ] **Instance templates should not assign a public IP address** - pass: no instance template defines an `accessConfig`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud compute instance-templates list --project="$p" --format="table(name, properties.networkInterfaces[0].accessConfigs[0].name)"; done`
  - **Verify**: the access-config column is empty for every template. A template is the durable version of the misconfiguration - every instance a managed instance group creates from it gets a public address, including ones created by autoscaling at 3am.
  - **Fix**: templates are immutable. Create a replacement with `gcloud compute instance-templates create <name> --no-address`, point the managed instance group at it with `gcloud compute instance-groups managed set-instance-template`, then roll the instances.

- [ ] **Check for Instances Associated with Default Service Accounts** - pass: no instance runs as the default Compute Engine service account
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud compute instances list --project="$p" --format="table(name, zone, serviceAccounts[0].email)" --filter="serviceAccounts[0].email~compute@developer.gserviceaccount.com"; done`
  - **Verify**: no rows. The default Compute Engine service account is granted `roles/editor` on the project automatically, so any code on that instance can modify nearly every resource in the project.
  - **Fix**: create a purpose-built service account, then stop the instance and `gcloud compute instances set-service-account <instance> --service-account=<sa> --scopes=cloud-platform --zone=<zone>`. Prevent the automatic grant with `constraints/iam.automaticIamGrantsForDefaultServiceAccounts`.

- [ ] **Check for Instance-Associated Service Accounts with Full API Access** - pass: no instance uses the `cloud-platform` scope with a broad service account
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud compute instances list --project="$p" --format="table(name, zone, serviceAccounts[0].email, serviceAccounts[0].scopes)" --filter="serviceAccounts[0].scopes:https://www.googleapis.com/auth/cloud-platform"; done`
  - **Verify**: instances using the full `cloud-platform` scope do so with a tightly-scoped service account, not the default one. Scopes are a legacy second layer - the safe pattern is `cloud-platform` scope plus a minimal service account, never a broad account with broad scopes.
  - **Fix**: `gcloud compute instances set-service-account <instance> --service-account=<minimal-sa> --scopes=cloud-platform --zone=<zone>` after stopping the instance, and strip the IAM roles the account does not need.

- [ ] **Disable IP Forwarding for Virtual Machine Instances** - pass: `canIpForward` = `false`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud compute instances list --project="$p" --format="table(name, zone, canIpForward)" --filter="canIpForward=true"; done`
  - **Verify**: no rows, except deliberate NAT or VPN appliances. An instance that can forward packets can route traffic for addresses it does not own, which turns a single compromised host into a pivot into other subnets.
  - **Fix**: `canIpForward` cannot be changed after creation. Recreate the instance without `--can-ip-forward`, and enforce with `constraints/compute.vmCanIpForward`.

- [ ] **Disable Interactive Serial Console Support** - pass: `serial-port-enable` is absent or `false`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud compute instances list --project="$p" --format="table(name, zone, metadata.items.filter('key:serial-port-enable').extract('value'))"; done`
  - **Verify**: empty or `false` for every instance. The interactive serial console is reachable with no IP restriction and no firewall in the path - it bypasses every network control you have configured.
  - **Fix**: `gcloud compute instances add-metadata <instance> --metadata serial-port-enable=false --zone=<zone>`, and enforce organization-wide with `constraints/compute.disableSerialPortAccess`.

- [ ] **Enable "Block Project-Wide SSH Keys" Security Feature** - pass: `block-project-ssh-keys` = `true` on every instance
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud compute instances list --project="$p" --format="table(name, zone, metadata.items.filter('key:block-project-ssh-keys').extract('value'))"; done`
  - **Verify**: `True` on every instance, or OS Login enabled project-wide (which supersedes this). A project-wide key grants shell access to every instance at once, and those keys are rarely inventoried.
  - **Fix**: `gcloud compute instances add-metadata <instance> --metadata block-project-ssh-keys=true --zone=<zone>`. Enabling OS Login is the better answer - it makes metadata keys irrelevant.

- [ ] **Enable OS Login for GCP Projects** - pass: `enable-oslogin` = `TRUE` in project metadata
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do echo "$p: $(gcloud compute project-info describe --project="$p" --format='value(commonInstanceMetadata.items.filter("key:enable-oslogin").extract("value"))')"; done`
  - **Verify**: `TRUE` for every project. Without OS Login, SSH access is governed by keys in metadata rather than IAM, so revoking someone's Google account does not revoke their shell access.
  - **Fix**: `gcloud compute project-info add-metadata --metadata enable-oslogin=TRUE --project=<project>`, grant `roles/compute.osLogin` (or `osAdminLogin`), and enforce with `constraints/compute.requireOsLogin`.

- [ ] **Use OS Login with 2FA Authentication for VM Instances** - pass: `enable-oslogin-2fa` = `TRUE`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do echo "$p: $(gcloud compute project-info describe --project="$p" --format='value(commonInstanceMetadata.items.filter("key:enable-oslogin-2fa").extract("value"))')"; done`
  - **Verify**: `TRUE` for every project holding production instances. Otherwise a stolen Google session cookie is enough to reach a shell on the host.
  - **Fix**: `gcloud compute project-info add-metadata --metadata enable-oslogin-2fa=TRUE --project=<project>`. Requires OS Login above and 2-Step Verification on the account.

- [ ] **Check for Publicly Shared Disk Images** - pass: no custom image grants `allUsers` or `allAuthenticatedUsers`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do for i in $(gcloud compute images list --project="$p" --no-standard-images --format="value(name)"); do gcloud compute images get-iam-policy "$i" --project="$p" --format=json | grep -qE '"allUsers"|"allAuthenticatedUsers"' && echo "PUBLIC: $p $i"; done; done`
  - **Verify**: no output. A disk image is a full filesystem - public images have leaked source code, private keys, and internal configuration to anyone who thought to look.
  - **Fix**: `gcloud compute images remove-iam-policy-binding <image> --member=allUsers --role=roles/compute.imageUser`. Treat any prior exposure as a disclosure and rotate every secret the image contained.

---

## Kubernetes (GKE)

- [ ] **Disable Client Certificates** - pass: `clientCertificateConfig.issueClientCertificate` is unset or `false`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud container clusters list --project="$p" --format="table(name, location, masterAuth.clientCertificate.yesno(yes='ISSUED', no='none'))"; done`
  - **Verify**: `none` for every cluster. A client certificate is a static credential that cannot be revoked without rotating the cluster's certificate authority, and it bypasses IAM entirely.
  - **Fix**: client certificates cannot be removed from a running cluster. Recreate it with `--no-issue-client-certificate` and migrate workloads, or at minimum rotate credentials with `gcloud container clusters update <cluster> --start-credential-rotation`.

- [ ] **Disable Kubernetes Dashboard for GKE Clusters** - pass: the Kubernetes dashboard addon is disabled
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud container clusters list --project="$p" --format="table(name, location, addonsConfig.kubernetesDashboard.disabled)"; done`
  - **Verify**: `True` for every cluster. The dashboard has a history of being deployed with a privileged service account and reachable without authentication - it was the entry point in the well-known Tesla cryptomining incident.
  - **Fix**: `gcloud container clusters update <cluster> --update-addons=KubernetesDashboard=DISABLED --zone=<zone>`. Use the Cloud Console or `kubectl` instead.

- [ ] **Disable Legacy Authorization** - pass: `legacyAbac.enabled` is unset or `false`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud container clusters list --project="$p" --format="table(name, location, legacyAbac.enabled)"; done`
  - **Verify**: empty or `False` for every cluster. Legacy ABAC grants broad permissions that override RBAC, so your carefully written Roles and RoleBindings simply do not apply.
  - **Fix**: `gcloud container clusters update <cluster> --no-enable-legacy-authorization --zone=<zone>`

- [ ] **Enable Private Nodes** - pass: `privateClusterConfig.enablePrivateNodes` = `true`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud container clusters list --project="$p" --format="table(name, location, privateClusterConfig.enablePrivateNodes)"; done`
  - **Verify**: `True` for every cluster. Nodes with public addresses expose the kubelet and every `hostNetwork` pod directly to the internet.
  - **Fix**: private nodes cannot be enabled on an existing cluster. Recreate with `gcloud container clusters create <cluster> --enable-private-nodes --enable-ip-alias --master-ipv4-cidr=<cidr>` and add Cloud NAT for egress.

- [ ] **Restrict Network Access** - pass: master authorized networks enabled with no `0.0.0.0/0` block
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud container clusters list --project="$p" --format="table(name, location, masterAuthorizedNetworksConfig.enabled, masterAuthorizedNetworksConfig.cidrBlocks[].cidrBlock)"; done`
  - **Verify**: `enabled` is `True` and no block is `0.0.0.0/0`. An enabled config that allows the world is the same as no config, and reads as compliant in a shallow review.
  - **Fix**: `gcloud container clusters update <cluster> --enable-master-authorized-networks --master-authorized-networks=<office-cidr>,<vpn-cidr>,<ci-egress>/32 --zone=<zone>`

- [ ] **Use GKE Clusters with Private Endpoints Only** - pass: `enablePrivateEndpoint` = `true`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud container clusters list --project="$p" --format="table(name, location, privateClusterConfig.enablePrivateEndpoint, privateClusterConfig.publicEndpoint)"; done`
  - **Verify**: `True`, with no public endpoint address. Otherwise the control plane accepts authentication attempts from the entire internet.
  - **Fix**: `gcloud container clusters update <cluster> --enable-private-endpoint --zone=<zone>`. Confirm your CI runners have a network path into the VPC first, or deployments will stop.

- [ ] **Enable Workload Identity Federation** - pass: `workloadIdentityConfig.workloadPool` is set
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud container clusters list --project="$p" --format="table(name, location, workloadIdentityConfig.workloadPool)"; done`
  - **Verify**: a workload pool of the form `<project>.svc.id.goog` on every cluster. Without it, pods authenticate as the node's service account, so every pod on a node shares one identity and the node's full permissions.
  - **Fix**: `gcloud container clusters update <cluster> --workload-pool=<project>.svc.id.goog --zone=<zone>`, then enable it per node pool with `--workload-metadata=GKE_METADATA` and bind Kubernetes service accounts to Google service accounts.

- [ ] **Prevent Default Service Account Usage** - pass: no node pool runs as the default Compute Engine service account
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do for c in $(gcloud container clusters list --project="$p" --format="value(name)"); do gcloud container node-pools list --cluster="$c" --project="$p" --region=<region> --format="table(name, config.serviceAccount)" 2>/dev/null | sed "s|^|$c |"; done; done`
  - **Verify**: no node pool shows `default`. The default account carries `roles/editor` on the project, which every pod on those nodes inherits unless Workload Identity is in force.
  - **Fix**: node pool service accounts are immutable. Create a replacement pool with `gcloud container node-pools create <pool> --service-account=<minimal-sa> --cluster=<cluster>`, then cordon, drain and delete the old pool.

---

## Logging & Detection

Each monitoring control needs two things: a log-based metric that matches the events, and an enabled alert policy attached to that metric. A metric with no alert produces a chart nobody opens.

- [ ] **Enable Monitoring for Audit Configuration Changes** - pass: a metric and enabled alert policy exist for audit config changes
  - **Run**: `gcloud logging metrics list --format="table(name, filter)"` and `gcloud alpha monitoring policies list --format="table(displayName, enabled, conditions[].conditionThreshold.filter)"`
  - **Verify**: a metric filtering `protoPayload.methodName="SetIamPolicy" AND protoPayload.serviceData.policyDelta.auditConfigDeltas:*` and an alert policy whose condition filter names that metric with `enabled` = `True`. Disabling audit logging is the first move in a quiet intrusion.
  - **Fix**: `gcloud logging metrics create audit-config-changes --log-filter='protoPayload.methodName="SetIamPolicy" AND protoPayload.serviceData.policyDelta.auditConfigDeltas:*'`, then attach an alert policy with a notification channel.

- [ ] **Enable Monitoring for Firewall Rule Changes** - pass: a metric and enabled alert policy exist for firewall changes
  - **Run**: `gcloud logging metrics list --filter="name~firewall" --format="table(name, filter)"` and `gcloud alpha monitoring policies list --format="table(displayName, enabled, conditions[].conditionThreshold.filter)"`
  - **Verify**: a metric matching firewall insert, patch and delete methods, and an alert policy whose condition filter names that metric with `enabled` = `True`. Opening a port is a single API call and is trivially reversible, so it will not be noticed unless it is alerted on.
  - **Fix**: `gcloud logging metrics create firewall-changes --log-filter='resource.type="gce_firewall_rule" AND (protoPayload.methodName:"compute.firewalls.insert" OR protoPayload.methodName:"compute.firewalls.patch" OR protoPayload.methodName:"compute.firewalls.delete")'`, plus an alert policy.

- [ ] **Enable Monitoring for Custom Role Changes** - pass: a metric and enabled alert policy exist for role changes
  - **Run**: `gcloud logging metrics list --filter="name~role" --format="table(name, filter)"` and `gcloud alpha monitoring policies list --format="table(displayName, enabled, conditions[].conditionThreshold.filter)"`
  - **Verify**: a metric matching `google.iam.admin.v1.CreateRole`, `UpdateRole` and `DeleteRole`, and an alert policy whose condition filter names that metric with `enabled` = `True`. Quietly adding a permission to an existing custom role escalates everyone who holds it, without any new binding appearing.
  - **Fix**: `gcloud logging metrics create custom-role-changes --log-filter='resource.type="iam_role" AND (protoPayload.methodName="google.iam.admin.v1.CreateRole" OR protoPayload.methodName="google.iam.admin.v1.UpdateRole" OR protoPayload.methodName="google.iam.admin.v1.DeleteRole")'`, plus an alert policy.

- [ ] **Enable Monitoring for Bucket Permission Changes** - pass: a metric and enabled alert policy exist for bucket IAM changes
  - **Run**: `gcloud logging metrics list --filter="name~bucket" --format="table(name, filter)"` and `gcloud alpha monitoring policies list --format="table(displayName, enabled, conditions[].conditionThreshold.filter)"`
  - **Verify**: a metric matching `storage.setIamPermissions`, and an alert policy whose condition filter names that metric with `enabled` = `True`. Making a bucket public is one API call, and the data is gone before a scheduled scan would find it.
  - **Fix**: `gcloud logging metrics create bucket-permission-changes --log-filter='resource.type="gcs_bucket" AND protoPayload.methodName="storage.setIamPermissions"'`, plus an alert policy.

- [ ] **Enable Project Ownership Assignments Monitoring** - pass: a metric and enabled alert policy exist for owner grants
  - **Run**: `gcloud logging metrics list --filter="name~owner" --format="table(name, filter)"` and `gcloud alpha monitoring policies list --format="table(displayName, enabled, conditions[].conditionThreshold.filter)"`
  - **Verify**: a metric matching `roles/owner` additions in `PROJECT_OWNERSHIP` or `SetIamPolicy` deltas, and an alert policy whose condition filter names that metric with `enabled` = `True`. Granting owner is the cleanest way to establish persistence, and it looks like ordinary administration in the logs.
  - **Fix**: `gcloud logging metrics create project-ownership-changes --log-filter='(protoPayload.serviceName="cloudresourcemanager.googleapis.com") AND (ProjectOwnership OR projectOwnerInvitee) OR (protoPayload.serviceData.policyDelta.bindingDeltas.action="ADD" AND protoPayload.serviceData.policyDelta.bindingDeltas.role="roles/owner")'`, plus an alert policy.

- [ ] **Enable VPC Network Changes Monitoring** - pass: a metric and enabled alert policy exist for network and route changes
  - **Run**: `gcloud logging metrics list --filter="name~(vpc OR network OR route)" --format="table(name, filter)"` and `gcloud alpha monitoring policies list --format="table(displayName, enabled, conditions[].conditionThreshold.filter)"`
  - **Verify**: metrics covering `compute.networks.*` and `compute.routes.*`, and alert policies whose condition filter names each metric with `enabled` = `True`. A new route or peering connection can redirect traffic or create an exfiltration path without touching any firewall rule.
  - **Fix**: `gcloud logging metrics create vpc-network-changes --log-filter='resource.type="gce_network" AND (protoPayload.methodName:"compute.networks." OR protoPayload.methodName:"compute.routes." OR protoPayload.methodName:"compute.networks.addPeering")'`, plus an alert policy.

- [ ] **Enable Monitoring for SQL Instance Configuration Changes** - pass: a metric and enabled alert policy exist for Cloud SQL changes
  - **Run**: `gcloud logging metrics list --filter="name~sql" --format="table(name, filter)"` and `gcloud alpha monitoring policies list --format="table(displayName, enabled, conditions[].conditionThreshold.filter)"`
  - **Verify**: a metric matching `cloudsql.instances.update`, and an alert policy whose condition filter names that metric with `enabled` = `True`. Adding a public IP or an authorized network of `0.0.0.0/0` is a configuration change, not an attack signature - only an alert distinguishes it from routine work.
  - **Fix**: `gcloud logging metrics create sql-instance-changes --log-filter='protoPayload.methodName="cloudsql.instances.update"'`, plus an alert policy.

- [ ] **Enable data access audit logging for all critical service APIs** - pass: `DATA_READ` and `DATA_WRITE` enabled for `allServices`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do echo "== $p"; gcloud projects get-iam-policy "$p" --format="json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('auditConfigs','NONE'))"; done`
  - **Verify**: an `auditConfigs` entry for `allServices` covering `ADMIN_READ`, `DATA_READ` and `DATA_WRITE`, with no `exemptedMembers`. Exempted members are invisible in the audit trail - which is precisely the property an attacker wants.
  - **Fix**: add the audit config to the IAM policy and apply with `gcloud projects set-iam-policy <project> policy.json`. Set it at the organization level so new projects inherit it.

- [ ] **Export All Log Entries Using Sinks** - pass: an aggregated sink exports logs outside the source project
  - **Run**: `gcloud logging sinks list --organization=$ORG_ID --format="table(name, destination, filter)"` and `for p in $(gcloud projects list --format="value(projectId)"); do gcloud logging sinks list --project="$p" --format="table(name, destination)"; done`
  - **Verify**: an organization-level aggregated sink exists, writing to a bucket or dataset in a separate, locked-down project. Logs kept only in the project being attacked are logs the attacker can delete.
  - **Fix**: `gcloud logging sinks create org-audit-sink storage.googleapis.com/<bucket> --organization=$ORG_ID --include-children --log-filter=""`, then grant the sink's writer identity access to the destination and apply bucket lock for retention.

---

## Encryption Keys (Cloud KMS)

- [ ] **Check for Publicly Accessible Cloud KMS Keys** - pass: no key or keyring grants `allUsers` or `allAuthenticatedUsers`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do for loc in $(gcloud kms locations list --format="value(locationId)" 2>/dev/null); do for kr in $(gcloud kms keyrings list --location="$loc" --project="$p" --format="value(name)" 2>/dev/null); do for k in $(gcloud kms keys list --keyring="$kr" --location="$loc" --project="$p" --format="value(name)" 2>/dev/null); do gcloud kms keys get-iam-policy "$k" --keyring="$kr" --location="$loc" --project="$p" --format=json | grep -qE '"allUsers"|"allAuthenticatedUsers"' && echo "PUBLIC KEY: $k"; done; done; done; done`
  - **Verify**: no output. A publicly accessible key makes the encryption decorative - anyone who can reach the ciphertext can also call `decrypt`.
  - **Fix**: `gcloud kms keys remove-iam-policy-binding <key> --keyring=<keyring> --location=<location> --member=allUsers --role=roles/cloudkms.cryptoKeyDecrypter`, and check the keyring policy too, since bindings there are inherited by every key under it.

---

## Databases (Cloud SQL)

- [ ] **Check for Cloud SQL Database Instances with Public IPs** - pass: no instance has a `PRIMARY` public IP
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud sql instances list --project="$p" --format="table(name, region, ipAddresses[].type.list(), settings.ipConfiguration.ipv4Enabled)"; done`
  - **Verify**: `ipv4Enabled` is `False` and no address of type `PRIMARY` appears. A public IP puts the database on the internet, guarded only by authorized networks and the database password.
  - **Fix**: `gcloud sql instances patch <instance> --no-assign-ip --network=projects/<project>/global/networks/<vpc>` to move to private service access, and connect through the Cloud SQL Auth Proxy.

- [ ] **Check for Publicly Accessible Cloud SQL Database Instances** - pass: no authorized network is `0.0.0.0/0`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud sql instances list --project="$p" --format="table(name, settings.ipConfiguration.authorizedNetworks[].value.list())"; done`
  - **Verify**: no instance lists `0.0.0.0/0`. That single entry makes the database reachable from every host on the internet, leaving the password as the only control.
  - **Fix**: `gcloud sql instances patch <instance> --authorized-networks=<office-cidr>`, or remove public access entirely with `--no-assign-ip` and use the Auth Proxy.

- [ ] **Configure Root Password for MySQL Database Access** - pass: the `root` user has a password set
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do for i in $(gcloud sql instances list --project="$p" --filter="databaseVersion~MYSQL" --format="value(name)"); do echo "== $p/$i"; gcloud sql users list --instance="$i" --project="$p" --format="table(name, host)"; done; done`
  - **Verify**: a `root` user exists with a host restriction, and you can confirm a password was set at creation. A MySQL instance created without `--root-password` has a blank root password, and if a public IP is also present that is an unauthenticated database on the internet.
  - **Fix**: `gcloud sql users set-password root --host=% --instance=<instance> --prompt-for-password`, and restrict the host from `%` to specific addresses where possible.

- [ ] **Disable "local_infile" Flag for MySQL Database Instances** - pass: `local_infile` = `off`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud sql instances list --project="$p" --filter="databaseVersion~MYSQL" --format="table(name, settings.databaseFlags[].name.list(), settings.databaseFlags[].value.list())"; done`
  - **Verify**: `local_infile` appears with value `off`. When on, a compromised or malicious MySQL server can read files from the connecting client's filesystem, and it widens SQL injection into local file disclosure.
  - **Fix**: `gcloud sql instances patch <instance> --database-flags local_infile=off`. Patching flags replaces the whole set - include every flag you already rely on in the same command.

- [ ] **Disable "Cross DB Ownership Chaining" Flag for SQL Server** - pass: `cross db ownership chaining` = `off`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud sql instances list --project="$p" --filter="databaseVersion~SQLSERVER" --format="table(name, settings.databaseFlags[].name.list(), settings.databaseFlags[].value.list())"; done`
  - **Verify**: the flag appears with value `off`. Ownership chaining lets a user in one database reach objects in another without a permission check there, which defeats per-database isolation on a shared instance.
  - **Fix**: `gcloud sql instances patch <instance> --database-flags "cross db ownership chaining=off"`

- [ ] **Disable "remote access" Flag for SQL Server** - pass: `remote access` = `off`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud sql instances list --project="$p" --filter="databaseVersion~SQLSERVER" --format="table(name, settings.databaseFlags[].name.list(), settings.databaseFlags[].value.list())"; done`
  - **Verify**: the flag appears with value `off`. Remote access permits running stored procedures from remote servers, which can be chained for lateral movement between instances.
  - **Fix**: `gcloud sql instances patch <instance> --database-flags "remote access=off"`

---

## Networking (Cloud VPC)

Firewall rules apply to a network, not a subnet, and `0.0.0.0/0` in `sourceRanges` means the internet. Each port check below looks for an ingress allow rule reaching that port from anywhere.

- [ ] **Default VPC Network In Use** - pass: no project uses the auto-created `default` network
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do n=$(gcloud compute networks list --project="$p" --filter="name=default" --format="value(name)"); [ -n "$n" ] && echo "$p: default network present"; done`
  - **Verify**: no output. The default network ships with auto-created subnets in every region and permissive rules allowing internal traffic plus SSH, RDP and ICMP from anywhere - none of which you chose.
  - **Fix**: migrate to a custom-mode VPC, then `gcloud compute networks delete default --project=<project>`. Stop it being created in new projects with `constraints/compute.skipDefaultNetworkCreation`.

- [ ] **Check for Unrestricted SSH Access** - pass: no firewall rule allows port 22 from `0.0.0.0/0`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud compute firewall-rules list --project="$p" --filter="direction=INGRESS AND disabled=false AND sourceRanges:0.0.0.0/0 AND (allowed.ports:22 OR allowed.ports~'^$')" --format="table(name, network, allowed[].map().firewall_rule().list())"; done`
  - **Verify**: no rows. Include rules with an empty port list - those allow *all* ports and are the easiest to miss. Open SSH is scanned and brute-forced continuously.
  - **Fix**: `gcloud compute firewall-rules update <rule> --source-ranges=<office-cidr>` or delete it, and use IAP TCP forwarding (`gcloud compute ssh <instance> --tunnel-through-iap`), which needs no open port.

- [ ] **Check for Unrestricted RDP Access** - pass: no firewall rule allows port 3389 from `0.0.0.0/0`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud compute firewall-rules list --project="$p" --filter="direction=INGRESS AND disabled=false AND sourceRanges:0.0.0.0/0 AND allowed.ports:3389" --format="table(name, network, targetTags)"; done`
  - **Verify**: no rows. Exposed RDP is the primary initial-access vector for ransomware operators.
  - **Fix**: `gcloud compute firewall-rules update <rule> --source-ranges=<office-cidr>`, or delete it and use IAP for Windows remote desktop.

- [ ] **Check for Unrestricted MySQL Database Access** - pass: no firewall rule allows port 3306 from `0.0.0.0/0`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud compute firewall-rules list --project="$p" --filter="direction=INGRESS AND disabled=false AND sourceRanges:0.0.0.0/0 AND allowed.ports:3306" --format="table(name, network, targetTags)"; done`
  - **Verify**: no rows. A database reachable from the internet is one credential-stuffing run from full data disclosure.
  - **Fix**: `gcloud compute firewall-rules update <rule> --source-ranges=<app-subnet-cidr>`, or scope by service account with `--target-service-accounts` so only the application tier can connect.

- [ ] **Check for Unrestricted PostgreSQL Database Access** - pass: no firewall rule allows port 5432 from `0.0.0.0/0`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud compute firewall-rules list --project="$p" --filter="direction=INGRESS AND disabled=false AND sourceRanges:0.0.0.0/0 AND allowed.ports:5432" --format="table(name, network, targetTags)"; done`
  - **Verify**: no rows.
  - **Fix**: `gcloud compute firewall-rules update <rule> --source-ranges=<app-subnet-cidr>`, or delete the rule and reach the database over a private path.

- [ ] **Check for Unrestricted SQL Server Access** - pass: no firewall rule allows port 1433 from `0.0.0.0/0`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud compute firewall-rules list --project="$p" --filter="direction=INGRESS AND disabled=false AND sourceRanges:0.0.0.0/0 AND allowed.ports:1433" --format="table(name, network, targetTags)"; done`
  - **Verify**: no rows.
  - **Fix**: `gcloud compute firewall-rules update <rule> --source-ranges=<app-subnet-cidr>` or delete it.

- [ ] **Check for Unrestricted Redis Access** - pass: no firewall rule allows port 6379 from `0.0.0.0/0`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud compute firewall-rules list --project="$p" --filter="direction=INGRESS AND disabled=false AND sourceRanges:0.0.0.0/0 AND allowed.ports:6379" --format="table(name, network, targetTags)"; done`
  - **Verify**: no rows. Redis is unauthenticated by default and its `CONFIG` command can write files to disk - exposure is frequently direct code execution.
  - **Fix**: `gcloud compute firewall-rules update <rule> --source-ranges=<app-subnet-cidr>`, and use Memorystore with AUTH and private service access.

- [ ] **Check for Unrestricted SMTP Access** - pass: no firewall rule allows port 25 from `0.0.0.0/0`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud compute firewall-rules list --project="$p" --filter="direction=INGRESS AND disabled=false AND sourceRanges:0.0.0.0/0 AND allowed.ports:25" --format="table(name, network, targetTags)"; done`
  - **Verify**: no rows. An open relay gets your address space blocklisted and your domain used for phishing that appears to come from you.
  - **Fix**: `gcloud compute firewall-rules delete <rule>` and send mail through a managed provider rather than running a relay.

- [ ] **Check for Unrestricted Outbound Access on All Ports** - pass: egress is not a blanket allow to `0.0.0.0/0`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud compute firewall-rules list --project="$p" --filter="direction=EGRESS AND disabled=false AND destinationRanges:0.0.0.0/0 AND allowed.IPProtocol:all" --format="table(name, network, priority)"; done`
  - **Verify**: no permissive egress rule at a priority below your deny rules. Open egress is what turns a foothold into data exfiltration and command-and-control; GCP allows all egress by default, so this needs a deliberate change.
  - **Fix**: create a low-priority deny-all egress rule (`gcloud compute firewall-rules create deny-all-egress --direction=EGRESS --action=DENY --rules=all --destination-ranges=0.0.0.0/0 --priority=65534`) then allow specific destinations above it.

- [ ] **Check for VPC Firewall Rules with Port Ranges** - pass: no allow rule opens a contiguous port range
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud compute firewall-rules list --project="$p" --filter="direction=INGRESS AND disabled=false" --format="value(name, allowed[].map().firewall_rule().list())" | grep -E '[0-9]+-[0-9]+' | sed "s|^|$p |"; done`
  - **Verify**: no output. A range such as `1-65535` or `1024-65535` exposes every service that will ever listen on the host, including ones added long after the rule was written.
  - **Fix**: `gcloud compute firewall-rules update <rule> --rules=tcp:<port1>,tcp:<port2>` naming only the ports actually in use.

- [ ] **Enable VPC Flow Logs for VPC Subnets** - pass: `enableFlowLogs` = `True` on every subnet
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud compute networks subnets list --project="$p" --format="table(name, region, network, enableFlowLogs)"; done`
  - **Verify**: `True` on every subnet carrying workloads. Without flow logs there is no record of what talked to what, so an intrusion cannot be scoped after the fact.
  - **Fix**: `gcloud compute networks subnets update <subnet> --region=<region> --enable-flow-logs --logging-aggregation-interval=interval-5-sec --logging-flow-sampling=0.5`. Tune sampling against cost rather than disabling it.

- [ ] **Enable Logging for VPC Firewall Rules** - pass: `logConfig.enable` = `True` on every allow rule
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud compute firewall-rules list --project="$p" --format="table(name, direction, logConfig.enable)"; done`
  - **Verify**: `True` at least on every ingress allow rule. Firewall logs are what tell you a rule is being exercised - and by whom - which is also how you find rules that can safely be removed.
  - **Fix**: `gcloud compute firewall-rules update <rule> --enable-logging --logging-metadata=include-all`

- [ ] **Restrict Access to High Risk Ports** - pass: no rule allows NetBIOS, SMB, RPC or Telnet from `0.0.0.0/0`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do for port in 23 135 137 138 139 445; do gcloud compute firewall-rules list --project="$p" --filter="direction=INGRESS AND disabled=false AND sourceRanges:0.0.0.0/0 AND allowed.ports:$port" --format="value(name)" | sed "s|^|$p port $port: |"; done; done`
  - **Verify**: no output. These are Windows file-sharing and legacy remote-access ports - SMB on 445 is the port behind EternalBlue and most self-propagating ransomware, and Telnet carries credentials in cleartext.
  - **Fix**: `gcloud compute firewall-rules delete <rule>`. None of these should ever cross a VPC boundary; where needed internally, scope `--source-ranges` to the specific subnet.

---

## Functions (Cloud Functions)

- [ ] **Publicly Accessible Functions** - pass: no function grants invoker to `allUsers`
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do for f in $(gcloud functions list --project="$p" --format="value(name)" 2>/dev/null); do gcloud functions get-iam-policy "$f" --project="$p" --format=json 2>/dev/null | grep -q '"allUsers"' && echo "PUBLIC: $p $f"; done; done`
  - **Verify**: no output, except functions that are deliberately public webhooks - and those should sit behind an API Gateway or load balancer with Cloud Armor. `allUsers` on an invoker role is an unauthenticated internet endpoint.
  - **Fix**: `gcloud functions remove-iam-policy-binding <function> --member=allUsers --role=roles/cloudfunctions.invoker`, then grant the specific service account that calls it.

- [ ] **GCP Functions with Admin Privileges** - pass: no function runs as a service account with owner, editor or admin
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud functions list --project="$p" --format="table(name, serviceAccountEmail)" 2>/dev/null; done` then check each account's roles with `gcloud projects get-iam-policy <project> --flatten="bindings[].members" --filter="bindings.members:serviceAccount:<sa>" --format="value(bindings.role)"`
  - **Verify**: no function's service account holds `roles/owner`, `roles/editor` or a `*.admin` role. The function's identity is available to any code it runs, including a compromised dependency.
  - **Fix**: `gcloud projects remove-iam-policy-binding <project> --member="serviceAccount:<sa>" --role="roles/editor"` and grant only the APIs the handler calls.

- [ ] **GCP Function using Default Service Account** - pass: no function uses the default App Engine or Compute service account
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do gcloud functions list --project="$p" --format="value(name, serviceAccountEmail)" 2>/dev/null | grep -E "appspot.gserviceaccount.com|compute@developer.gserviceaccount.com" | sed "s|^|$p |"; done`
  - **Verify**: no output. The default accounts carry `roles/editor`, so every function sharing one has write access to nearly the whole project and to each other's resources.
  - **Fix**: create a per-function service account, then redeploy with `gcloud functions deploy <function> --service-account=<sa>`.

- [ ] **Use Secrets Manager for Managing Secrets in Google Cloud Functions** - pass: no secret-shaped value in plaintext environment variables
  - **Run**: `for p in $(gcloud projects list --format="value(projectId)"); do for f in $(gcloud functions list --project="$p" --format="value(name)" 2>/dev/null); do echo "== $p/$f"; gcloud functions describe "$f" --project="$p" --format="value(serviceConfig.environmentVariables)" 2>/dev/null; done; done`
  - **Verify**: no variable whose name suggests a secret (`*KEY*`, `*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*CREDENTIAL*`) holds a literal value. Environment variables are visible to anyone with `cloudfunctions.functions.get` and appear in deployment logs and Terraform state.
  - **Fix**: `gcloud secrets create <secret> --data-file=-`, grant the function's service account `roles/secretmanager.secretAccessor`, then redeploy with `--set-secrets=<ENV_VAR>=<secret>:latest`. Rotate every value that was previously in plaintext.

---

## Organization Policies

- [ ] **Define Allowed External IPs for VM Instances** - pass: `constraints/compute.vmExternalIpAccess` is enforced with a deny-all or allow-list
  - **Run**: `gcloud resource-manager org-policies describe constraints/compute.vmExternalIpAccess --organization=$ORG_ID --effective`
  - **Verify**: a `listPolicy` with `allValues: DENY`, or an explicit `allowedValues` list of the instances permitted an external IP. The default is unrestricted, so any project owner can publish a VM to the internet.
  - **Fix**: `gcloud resource-manager org-policies deny constraints/compute.vmExternalIpAccess --organization=$ORG_ID --all`, then allow-list specific instances by resource name as exceptions.

- [ ] **Disable Automatic IAM Role Grants for Default Service Accounts** - pass: `constraints/iam.automaticIamGrantsForDefaultServiceAccounts` is enforced
  - **Run**: `gcloud resource-manager org-policies describe constraints/iam.automaticIamGrantsForDefaultServiceAccounts --organization=$ORG_ID --effective`
  - **Verify**: `booleanPolicy.enforced` is `true`. Without it, every new project's default Compute Engine and App Engine service accounts are granted `roles/editor` automatically - over-privilege created at project creation, before anyone reviews anything.
  - **Fix**: `gcloud resource-manager org-policies enable-enforce constraints/iam.automaticIamGrantsForDefaultServiceAccounts --organization=$ORG_ID`. Existing projects keep their grants; remove those separately.

- [ ] **Disable Serial Port Access Support at Organization Level** - pass: `constraints/compute.disableSerialPortAccess` is enforced
  - **Run**: `gcloud resource-manager org-policies describe constraints/compute.disableSerialPortAccess --organization=$ORG_ID --effective`
  - **Verify**: `booleanPolicy.enforced` is `true`. The interactive serial console bypasses firewall rules and IP restrictions entirely, so a per-instance setting is not enough - this is the organization-wide backstop.
  - **Fix**: `gcloud resource-manager org-policies enable-enforce constraints/compute.disableSerialPortAccess --organization=$ORG_ID`

- [ ] **Disable Service Account Key Upload** - pass: `constraints/iam.disableServiceAccountKeyUpload` is enforced
  - **Run**: `gcloud resource-manager org-policies describe constraints/iam.disableServiceAccountKeyUpload --organization=$ORG_ID --effective`
  - **Verify**: `booleanPolicy.enforced` is `true`. Uploading external key material means the private key was generated outside Google and may exist in places you cannot audit.
  - **Fix**: `gcloud resource-manager org-policies enable-enforce constraints/iam.disableServiceAccountKeyUpload --organization=$ORG_ID`

- [ ] **Disable User-Managed Key Creation for Service Accounts** - pass: `constraints/iam.disableServiceAccountKeyCreation` is enforced
  - **Run**: `gcloud resource-manager org-policies describe constraints/iam.disableServiceAccountKeyCreation --organization=$ORG_ID --effective`
  - **Verify**: `booleanPolicy.enforced` is `true`. This is the structural version of the service account key controls above - it stops the next key being created rather than finding it later.
  - **Fix**: `gcloud resource-manager org-policies enable-enforce constraints/iam.disableServiceAccountKeyCreation --organization=$ORG_ID`. Migrate workloads to Workload Identity Federation first, or deployments that mint keys will fail.

- [ ] **Skip Default VPC Network Creation** - pass: `constraints/compute.skipDefaultNetworkCreation` is enforced
  - **Run**: `gcloud resource-manager org-policies describe constraints/compute.skipDefaultNetworkCreation --organization=$ORG_ID --effective`
  - **Verify**: `booleanPolicy.enforced` is `true`. Otherwise every new project gets a default network with permissive rules allowing SSH, RDP and ICMP from anywhere, and the clock starts before anyone has looked at it.
  - **Fix**: `gcloud resource-manager org-policies enable-enforce constraints/compute.skipDefaultNetworkCreation --organization=$ORG_ID`. Existing default networks are unaffected - delete those separately.
