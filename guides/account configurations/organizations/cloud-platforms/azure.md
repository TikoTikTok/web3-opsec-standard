<!--
id: azure-cloud-security
type: CONFIGURATION
scope: ORGANIZATION
-->

<div align="center">
  <img src="../../../../images/guides/azure.svg" alt="Azure Logo" width="64" height="64">
  <h2><a href="https://azure.microsoft.com/" target="_blank" rel="noopener noreferrer">Azure</a> Configuration Guide</h2>
  <p><em>Identity, Network, Data, and Detection controls for Microsoft Azure accounts</em></p>
</div>

---

## How to Use This Guide

Every checklist item below states its **pass condition** on the item line itself, then breaks into three parts:

- **Run** - the command that collects the current state. Copy it as-is; replace only the `<placeholders>`.
- **Verify** - the same condition in full: the exact field and value that counts as a pass, and why the failing state matters. If the output does not match, the item fails.
- **Fix** - the command or portal path that remediates it.

The condition is repeated on the item line so the control stays self-contained wherever the checklist is consumed as a flat list of items.

An item is only complete when **Verify** passes for *every* resource the command returns, not just the first one.

#### Prerequisites

- Azure CLI 2.60 or newer - check with `az version`.
- Sign in and pin the subscription you are auditing:
  - `az login`
  - `az account list --query "[].{name:name, id:id, tenant:tenantId}" -o table`
  - `az account set --subscription <subscription-id>`
- Repeat the whole guide **once per subscription**. Identity items are tenant-wide and only need to be run once.
- Identity items call Microsoft Graph through `az rest`. The signed-in account needs at least the **Global Reader** and **Reports Reader** roles to read them, and **Privileged Role Administrator** / **Global Administrator** to apply the fixes.

---

## Identity (Entra ID / Active Directory)

- [ ] **Enable Multi-Factor Authentication for Privileged Users** - pass: `isMfaRegistered` = `True` for every admin, with a phishing-resistant method
  - **Run**: `az rest --method GET --uri "https://graph.microsoft.com/v1.0/reports/authenticationMethods/userRegistrationDetails" --query "value[?isAdmin].{upn:userPrincipalName, mfaRegistered:isMfaRegistered, methods:methodsRegistered}" -o table`
  - **Verify**: every returned row has `mfaRegistered` = `True`, and `methods` contains a phishing-resistant method (`fido2`, `windowsHelloForBusiness`, `passKeyDeviceBound`). A row listing only `sms` or `voice` is a fail - those are SIM-swap prone.
  - **Fix**: Entra admin center > **Protection > Conditional Access > Policies > New policy** - assign to the privileged directory roles, target **All resources**, then **Grant > Require authentication strength > Phishing-resistant MFA**. Exclude one break-glass account and secure it with a FIDO2 key.

- [ ] **Enable Multi-Factor Authentication for Non-Privileged Users** - pass: the query returns no rows
  - **Run**: `az rest --method GET --uri "https://graph.microsoft.com/v1.0/reports/authenticationMethods/userRegistrationDetails" --query "value[?!isAdmin && !isMfaRegistered].{upn:userPrincipalName, type:userType}" -o table`
  - **Verify**: the command returns **no rows**. Any row is a member or guest who can sign in with a password alone.
  - **Fix**: Entra admin center > **Protection > Conditional Access > Policies > New policy** - assign to **All users**, target **All resources**, **Grant > Require multifactor authentication**. Roll it out in **Report-only** mode first, review sign-in logs, then switch to **On**.

- [ ] **Enable Security Defaults** - pass: `isEnabled` = `true`, or `false` where Conditional Access covers MFA instead
  - **Run**: `az rest --method GET --uri "https://graph.microsoft.com/v1.0/policies/identitySecurityDefaultsEnforcementPolicy" --query "{securityDefaults:isEnabled}"`
  - **Verify**: `securityDefaults` = `true` if the tenant has no Entra ID P1/P2 licence. If you use Conditional Access instead, this **must** be `false` (the two are mutually exclusive) and the two MFA items above must pass.
  - **Fix**: Entra admin center > **Overview > Properties > Manage security defaults** > **Enabled**.

- [ ] **Require Multi-Factor Auth To Join Devices** - pass: `multiFactorAuthConfiguration` = `required`
  - **Run**: `az rest --method GET --uri "https://graph.microsoft.com/v1.0/policies/deviceRegistrationPolicy" --query "{mfa:multiFactorAuthConfiguration, quota:userDeviceQuota}"`
  - **Verify**: `mfa` = `required`. `notRequired` means an attacker with a stolen password can enrol their own device into the tenant. (If v1.0 returns an error, retry the same path against `https://graph.microsoft.com/beta/`.)
  - **Fix**: Entra admin center > **Devices > Overview > Device settings** > **Require Multifactor Authentication to register or join devices** > **Yes**. Preferred alternative: a Conditional Access policy on the **Register or join devices** user action.

- [ ] **Restrict Access To Microsoft Entra ID Administration Portal** - pass: portal toggle reads **Yes** - there is no CLI equivalent
  - **Run**: this toggle has no supported Graph or CLI property. Check it in the portal: Entra admin center > **Users > User settings** > **Restrict access to Microsoft Entra admin center**. As a CLI proxy for how much a standard user can read, run `az rest --method GET --uri "https://graph.microsoft.com/v1.0/policies/authorizationPolicy" --query "value[0].defaultUserRolePermissions.allowedToReadOtherUsers"`.
  - **Verify**: the portal toggle reads **Yes**. The CLI proxy should return `false` so non-admins cannot enumerate the rest of the directory.
  - **Fix**: set the portal toggle to **Yes**. This blocks the admin center UI only - it is a reconnaissance control, not an authorization boundary, so pair it with least-privilege role assignments.

- [ ] **Guests Can Invite** - pass: `allowInvitesFrom` is not `everyone`
  - **Run**: `az rest --method GET --uri "https://graph.microsoft.com/v1.0/policies/authorizationPolicy" --query "value[0].allowInvitesFrom"`
  - **Verify**: the value is **not** `everyone`. `everyone` lets an existing guest invite further guests, so one compromised external account can grow its own foothold.
  - **Fix**: Entra admin center > **External Identities > External collaboration settings** > **Guest invite settings** > *Only users assigned to specific admin roles can invite guest users* (`adminsAndGuestInviters`).

- [ ] **Members Can Invite** - pass: `allowInvitesFrom` = `adminsAndGuestInviters` or `none`
  - **Run**: `az rest --method GET --uri "https://graph.microsoft.com/v1.0/policies/authorizationPolicy" --query "value[0].allowInvitesFrom"`
  - **Verify**: the value is `adminsAndGuestInviters` or `none`. `adminsGuestInvitersAndAllMembers` and `everyone` both allow any employee to add an external identity without review.
  - **Fix**: same setting as above - restrict invitations to the **Guest Inviter** role and assign that role deliberately.

- [ ] **Check for Microsoft Entra ID Guest Users** - pass: every guest is a current, named collaborator with a business reason
  - **Run**: `az ad user list --filter "userType eq 'Guest'" --query "[].{name:displayName, upn:userPrincipalName, mail:mail}" -o table`
  - **Verify**: every guest is a current, named external collaborator with a business reason. Guests from finished engagements are a fail - they keep whatever group memberships they were given.
  - **Fix**: remove stale guests with `az ad user delete --id <user-principal-name>`, and set Entra admin center > **External Identities > External collaboration settings** > **Guest user access** > *Guest user access is restricted to properties and memberships of their own directory objects*. Configure **Identity Governance > Access reviews** for a recurring guest review.

- [ ] **Disable Tenant Creation for Non-Admin Users** - pass: `allowedToCreateTenants` = `false`
  - **Run**: `az rest --method GET --uri "https://graph.microsoft.com/v1.0/policies/authorizationPolicy" --query "value[0].defaultUserRolePermissions.allowedToCreateTenants"`
  - **Verify**: `false`. When `true`, any user can spin up a tenant they are Global Admin of - unmonitored infrastructure carrying your company identity.
  - **Fix**: Entra admin center > **Users > User settings** > **Restrict non-admin users from creating tenants** > **Yes**.

- [ ] **Users Can Register Applications** - pass: `allowedToCreateApps` = `false`
  - **Run**: `az rest --method GET --uri "https://graph.microsoft.com/v1.0/policies/authorizationPolicy" --query "value[0].defaultUserRolePermissions.allowedToCreateApps"`
  - **Verify**: `false`. App registration by standard users creates credentials that outlive the user's account and are rarely reviewed.
  - **Fix**: Entra admin center > **Users > User settings** > **Users can register applications** > **No**. Grant the **Application Developer** role to the few people who genuinely need it.

- [ ] **Users Can Consent To Apps Accessing Company Data On Their Behalf** - pass: `permissionGrantPoliciesAssigned` is empty, or low-risk only
  - **Run**: `az rest --method GET --uri "https://graph.microsoft.com/v1.0/policies/authorizationPolicy" --query "value[0].defaultUserRolePermissions.permissionGrantPoliciesAssigned"`
  - **Verify**: the array is empty (`[]`, consent disabled) or contains only `ManagePermissionGrantsForSelf.microsoft-user-default-low`. `ManagePermissionGrantsForSelf.microsoft-user-default-legacy` is a fail - it is the setting illicit-consent phishing relies on.
  - **Fix**: Entra admin center > **Identity > Applications > Enterprise applications > Consent and permissions > User consent settings** > **Do not allow user consent** (or *verified publishers, selected permissions* for low risk). Then enable **Admin consent requests** so users have a path to ask.

- [ ] **Multi-factor Authentication On Devices** - pass: `Fido2` and `MicrosoftAuthenticator` enabled; `Sms`, `Voice`, `Email` disabled
  - **Run**: `az rest --method GET --uri "https://graph.microsoft.com/v1.0/policies/authenticationMethodsPolicy" --query "authenticationMethodConfigurations[].{method:id, state:state}" -o table`
  - **Verify**: `Fido2` and `MicrosoftAuthenticator` are `enabled`; `Sms`, `Voice` and `Email` are `disabled`. Leaving SMS or voice enabled means the weakest method is the one an attacker will target.
  - **Fix**: Entra admin center > **Protection > Authentication methods > Policies** - enable **Passkey (FIDO2)** and **Microsoft Authenticator**, disable **SMS**, **Voice call** and **Email OTP** after confirming no user depends on them.

---

## Virtual Machines

- [ ] **Disable Public Network Access to Virtual Machine Disks** - pass: `publicNetworkAccess` = `Disabled` and `networkAccessPolicy` = `DenyAll`
  - **Run**: `az disk list --query "[].{name:name, rg:resourceGroup, publicAccess:publicNetworkAccess, policy:networkAccessPolicy}" -o table`
  - **Verify**: every disk shows `publicAccess` = `Disabled` and `policy` = `DenyAll` (or `AllowPrivate` when a disk access resource is attached). `AllowAll` means a leaked SAS URL exports the whole disk over the internet.
  - **Fix**: `az disk update --name <disk> --resource-group <rg> --public-network-access Disabled --network-access-policy DenyAll`

- [ ] **Disable Public IP Address Assignment for VMSS Instances** - pass: `publicIPAddressConfiguration` is null on every scale set
  - **Run**: `az vmss list --query "[].{name:name, rg:resourceGroup, publicIp:virtualMachineProfile.networkProfile.networkInterfaceConfigurations[].ipConfigurations[].publicIPAddressConfiguration}" -o json`
  - **Verify**: `publicIp` is `null` or an empty list for every scale set. A non-null value means each instance gets its own internet-routable address, multiplying the attack surface with every scale-out.
  - **Fix**: Portal > **Virtual machine scale sets > <scale set> > Networking** - edit the network interface configuration and remove the public IP. Route outbound traffic through a **NAT gateway** and administer instances through **Azure Bastion**.

- [ ] **Check for SSH Authentication Type** - pass: `disablePasswordAuthentication` = `True` on every Linux VM
  - **Run**: `az vm list --query "[?storageProfile.osDisk.osType=='Linux'].{name:name, rg:resourceGroup, passwordAuthDisabled:osProfile.linuxConfiguration.disablePasswordAuthentication}" -o table`
  - **Verify**: `passwordAuthDisabled` = `True` on every Linux VM. `False` or blank means SSH password brute force is in scope.
  - **Fix**: `az vm run-command invoke -g <rg> -n <vm> --command-id RunShellScript --scripts "sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && systemctl restart sshd"` - confirm key-based login works in a second session **before** closing the first.

- [ ] **Enable Just-In-Time Access for Virtual Machines** - pass: every VM with an open management port appears in a JIT policy
  - **Run**: `az rest --method GET --uri "https://management.azure.com/subscriptions/$(az account show --query id -o tsv)/providers/Microsoft.Security/jitNetworkAccessPolicies?api-version=2020-01-01" --query "value[].{name:name, vms:properties.virtualMachines[].id}" -o json`
  - **Verify**: every VM that exposes a management port (22, 3389, 5985, 5986) appears in the `vms` list of a policy. A VM with an open management port and no JIT policy is permanently reachable.
  - **Fix**: Portal > **Microsoft Defender for Cloud > Workload protections > Just-in-time VM access** - select the VM and **Enable JIT on 1 VM**, with a request window of 1-3 hours. Requires the **Defender for Servers Plan 2** plan.

- [ ] **Enable System-Assigned Managed Identities** - pass: `identity.type` includes `SystemAssigned`
  - **Run**: `az vm list --query "[].{name:name, rg:resourceGroup, identity:identity.type}" -o table`
  - **Verify**: `identity` contains `SystemAssigned` on every VM that calls an Azure service. A blank value means the workload is authenticating with a static secret stored somewhere on the box.
  - **Fix**: `az vm identity assign -g <rg> -n <vm>`, grant the identity a scoped role with `az role assignment create --assignee <principal-id> --role <role> --scope <resource-id>`, then delete the secrets it replaces.

- [ ] **Enable Virtual Machine Access using Microsoft Entra ID Authentication** - pass: `AADSSHLoginForLinux` or `AADLoginForWindows` installed on every VM
  - **Run**: `az vm list --query "[].{n:name, g:resourceGroup}" -o tsv | while read n g; do echo "$n: $(az vm extension list -g "$g" --vm-name "$n" --query "[].name" -o tsv | tr '\n' ' ')"; done`
  - **Verify**: each VM lists `AADSSHLoginForLinux` (Linux) or `AADLoginForWindows` (Windows). Without it, access depends on local accounts and SSH keys that survive offboarding.
  - **Fix**: `az vm extension set --publisher Microsoft.Azure.ActiveDirectory --name AADSSHLoginForLinux -g <rg> --vm-name <vm>` (use `AADLoginForWindows` for Windows), then assign **Virtual Machine Administrator Login** or **Virtual Machine User Login** to the right Entra groups.

- [ ] **Install Approved Extensions Only** - pass: every installed extension is on your approved list
  - **Run**: `az vm list --query "[].{n:name, g:resourceGroup}" -o tsv | while read n g; do az vm extension list -g "$g" --vm-name "$n" --query "[].{vm:'$n', ext:name, publisher:publisher}" -o tsv; done`
  - **Verify**: every extension matches your approved list (monitoring, Entra login, Defender, backup agents). Extensions run as root/SYSTEM, so an unexpected one is a code-execution path.
  - **Fix**: `az vm extension delete -g <rg> --vm-name <vm> -n <extension-name>`, and assign the built-in Azure Policy **Only approved VM extensions should be installed** to stop the next one.

---

## Key Vault

- [ ] **Restrict Default Network Access for Azure Key Vaults** - pass: `defaultAction` = `Deny` and `publicNetworkAccess` = `Disabled`
  - **Run**: `az keyvault list --query "[].{name:name, rg:resourceGroup, defaultAction:properties.networkAcls.defaultAction, bypass:properties.networkAcls.bypass, publicAccess:properties.publicNetworkAccess}" -o table`
  - **Verify**: `defaultAction` = `Deny` and `publicAccess` = `Disabled`. `Allow` means a stolen token can be redeemed for your secrets from anywhere on the internet.
  - **Fix**: `az keyvault update --name <vault> --default-action Deny --public-network-access Disabled`. Allow-list the addresses that genuinely need it first with `az keyvault network-rule add --name <vault> --ip-address <cidr>`.

- [ ] **Use Private Endpoints for Key Vaults** - pass: at least one private endpoint connection in state `Approved`
  - **Run**: `az keyvault list --query "[].{name:name, rg:resourceGroup, endpoints:properties.privateEndpointConnections[].privateLinkServiceConnectionState.status}" -o table`
  - **Verify**: each vault has at least one connection in state `Approved`. An empty `endpoints` column means vault traffic leaves your virtual network.
  - **Fix**: `az network private-endpoint create --name <pe-name> -g <rg> --vnet-name <vnet> --subnet <subnet> --private-connection-resource-id $(az keyvault show --name <vault> --query id -o tsv) --group-id vault --connection-name <conn-name>`, then link a `privatelink.vaultcore.azure.net` private DNS zone.

- [ ] **Enable Role-Based Access Control (RBAC) Authorization** - pass: `enableRbacAuthorization` = `True` on every vault
  - **Run**: `az keyvault list --query "[].{name:name, rbac:properties.enableRbacAuthorization}" -o table`
  - **Verify**: `rbac` = `True` on every vault. Legacy access policies cannot be reviewed alongside the rest of your Azure role assignments, so over-grants go unnoticed.
  - **Fix**: `az keyvault update --name <vault> --enable-rbac-authorization true` - assign the equivalent RBAC roles (**Key Vault Secrets User**, **Key Vault Crypto User**) *before* flipping this, since existing access policies stop taking effect immediately.

- [ ] **Check for Key Vault Full Administrator Permissions** - pass: only named break-glass identities hold Administrator, Owner or Contributor
  - **Run**: `az keyvault list --query "[].id" -o tsv | while read id; do echo "== $id"; az role assignment list --scope "$id" --include-inherited --query "[?contains(roleDefinitionName, 'Administrator') || roleDefinitionName=='Owner' || roleDefinitionName=='Contributor'].{principal:principalName, role:roleDefinitionName}" -o tsv; done`
  - **Verify**: only named break-glass identities hold **Key Vault Administrator**, **Owner** or **Contributor** on a vault. Applications and CI should never appear here. On access-policy vaults, also check `az keyvault show --name <vault> --query "properties.accessPolicies[].permissions"` for entries granting all secret/key/certificate operations.
  - **Fix**: `az role assignment delete --assignee <principal-id> --role "Key Vault Administrator" --scope <vault-id>` and re-grant the narrowest role that works (**Key Vault Secrets User** for read-only consumers).

- [ ] **Ensure Purge Protection is Enabled for Key Vaults** - pass: `enablePurgeProtection` = `True` with 90-day retention
  - **Run**: `az keyvault list --query "[].{name:name, purgeProtection:properties.enablePurgeProtection, retentionDays:properties.softDeleteRetentionInDays}" -o table`
  - **Verify**: `purgeProtection` = `True` and `retentionDays` = `90`. Without it, an attacker with vault-delete rights can permanently destroy your keys - and any data they encrypt.
  - **Fix**: `az keyvault update --name <vault> --enable-purge-protection true`. This is **irreversible**: once on, a deleted vault cannot be purged before the retention window expires.

- [ ] **Enable Key Vault Recoverability** - pass: `enableSoftDelete` = `True` and `softDeleteRetentionInDays` = `90`
  - **Run**: `az keyvault list --query "[].{name:name, softDelete:properties.enableSoftDelete, retentionDays:properties.softDeleteRetentionInDays}" -o table`
  - **Verify**: `softDelete` = `True` with `retentionDays` = `90`. Also confirm nothing is sitting deleted and forgotten: `az keyvault list-deleted --query "[].{name:name, scheduledPurge:properties.scheduledPurgeDate}" -o table`.
  - **Fix**: `az keyvault update --name <vault> --retention-days 90`. Recover an accidentally deleted vault with `az keyvault recover --name <vault>`.

- [ ] **Azure Key Vault Cross-Subscription Access** - pass: every vault and access-policy `tenantId` matches your own
  - **Run**: `az account show --query tenantId -o tsv` then `az keyvault list --query "[].{name:name, vaultTenant:properties.tenantId, policyTenants:properties.accessPolicies[].tenantId}" -o json`
  - **Verify**: every `vaultTenant` and every entry in `policyTenants` matches your own tenant ID. A foreign tenant ID in an access policy is a live data path out of your environment.
  - **Fix**: `az keyvault delete-policy --name <vault> --object-id <object-id>` for each foreign principal. For RBAC vaults, remove the cross-tenant role assignment and block the pattern with an Entra **Cross-tenant access** policy.

---

## Kubernetes (AKS)

- [ ] **Disable Public FQDN for Private AKS Clusters** - pass: `enablePrivateClusterPublicFqdn` = `False` on private clusters
  - **Run**: `az aks list --query "[].{name:name, rg:resourceGroup, private:apiServerAccessProfile.enablePrivateCluster, publicFqdn:apiServerAccessProfile.enablePrivateClusterPublicFqdn}" -o table`
  - **Verify**: on every cluster with `private` = `True`, `publicFqdn` is `False` or blank. A public FQDN on a private cluster publishes the API server's resolvable name back to the internet.
  - **Fix**: `az aks update -g <rg> -n <cluster> --disable-public-fqdn`

- [ ] **Enable Kubernetes Role-Based Access Control** - pass: `enableRbac` = `True` on every cluster
  - **Run**: `az aks list --query "[].{name:name, rg:resourceGroup, k8sRbac:enableRbac}" -o table`
  - **Verify**: `k8sRbac` = `True` on every cluster. Without it, any authenticated principal is effectively cluster-admin.
  - **Fix**: this cannot be changed after creation. Rebuild the cluster with `az aks create ... --enable-rbac` (the default on current CLI versions) and migrate workloads.

- [ ] **Enable Azure Role-Based Access Control (RBAC) for Kubernetes Authorization** - pass: `aadProfile.enableAzureRbac` = `True`
  - **Run**: `az aks list --query "[].{name:name, rg:resourceGroup, azureRbac:aadProfile.enableAzureRbac}" -o table`
  - **Verify**: `azureRbac` = `True`. Otherwise cluster permissions live only in in-cluster RoleBindings, invisible to Entra reviews and offboarding.
  - **Fix**: `az aks update -g <rg> -n <cluster> --enable-azure-rbac`, then assign **Azure Kubernetes Service RBAC Reader/Writer/Admin** to Entra groups scoped to the cluster or namespace.

- [ ] **Use Microsoft Entra ID Integration with Kubernetes RBAC** - pass: `aadProfile.managed` = `True` and `disableLocalAccounts` = `True`
  - **Run**: `az aks list --query "[].{name:name, rg:resourceGroup, managedAad:aadProfile.managed, localAccounts:disableLocalAccounts}" -o table`
  - **Verify**: `managedAad` = `True` and `localAccounts` = `True` (local accounts disabled). A live `clusterAdmin` kubeconfig is a static credential that bypasses Entra entirely.
  - **Fix**: `az aks update -g <rg> -n <cluster> --enable-aad --disable-local-accounts`, then have users re-authenticate with `az aks get-credentials -g <rg> -n <cluster>`.

- [ ] **Enable Support for Network Policies** - pass: `networkPolicy` is `azure`, `calico` or `cilium`
  - **Run**: `az aks list --query "[].{name:name, rg:resourceGroup, networkPolicy:networkProfile.networkPolicy, plugin:networkProfile.networkPlugin}" -o table`
  - **Verify**: `networkPolicy` is `azure`, `calico` or `cilium`. A blank value means every pod can reach every other pod, so one compromised container reaches the whole cluster.
  - **Fix**: `az aks update -g <rg> -n <cluster> --network-policy azure` (supported on Azure CNI; older clusters may need a rebuild). Then apply a default-deny `NetworkPolicy` per namespace and allow-list the flows you need.

- [ ] **Kubernetes Clusters with Private Nodes** - pass: `enableNodePublicIp` = `False` on every node pool
  - **Run**: `az aks list --query "[].{n:name, g:resourceGroup}" -o tsv | while read n g; do az aks nodepool list --cluster-name "$n" -g "$g" --query "[].{cluster:'$n', pool:name, publicIp:enableNodePublicIp}" -o tsv; done`
  - **Verify**: `publicIp` is `False` for every node pool. Nodes with public IPs expose the kubelet and any hostNetwork pod directly.
  - **Fix**: recreate the node pool without the flag - `az aks nodepool add -g <rg> --cluster-name <cluster> -n <pool> --node-count <n>` (omit `--enable-node-public-ip`) - then cordon, drain and delete the old pool.

- [ ] **Private Kubernetes Clusters** - pass: `enablePrivateCluster` = `True` on production clusters
  - **Run**: `az aks list --query "[].{name:name, rg:resourceGroup, privateCluster:apiServerAccessProfile.enablePrivateCluster}" -o table`
  - **Verify**: `privateCluster` = `True` for production clusters, so the API server is reachable only over private networking.
  - **Fix**: this cannot be enabled after creation. Rebuild with `az aks create ... --enable-private-cluster`, and reach the API server over a VPN, ExpressRoute or a jump host in the same virtual network.

- [ ] **Secure Access to Kubernetes API Server Using Authorized IP Address Ranges** - pass: `authorizedIpRanges` non-empty and free of `0.0.0.0/0`
  - **Run**: `az aks list --query "[].{name:name, rg:resourceGroup, privateCluster:apiServerAccessProfile.enablePrivateCluster, allowedRanges:apiServerAccessProfile.authorizedIpRanges}" -o table`
  - **Verify**: any cluster with `privateCluster` = `False` has a non-empty `allowedRanges`, and that list contains no `0.0.0.0/0`. An empty list means the API server accepts connections from the entire internet.
  - **Fix**: `az aks update -g <rg> -n <cluster> --api-server-authorized-ip-ranges <office-cidr>,<vpn-cidr>,<ci-egress-ip>/32` - include your CI runner's egress IP or you will lock out deployments.

- [ ] **Use Private Key Vaults for Encryption at Rest in Azure Kubernetes Service** - pass: `azureKeyVaultKms.enabled` = `True` with `keyVaultNetworkAccess` = `Private`
  - **Run**: `az aks list --query "[].{name:name, rg:resourceGroup, kms:securityProfile.azureKeyVaultKms.enabled, kvAccess:securityProfile.azureKeyVaultKms.keyVaultNetworkAccess, diskEncryptionSet:diskEncryptionSetId}" -o table`
  - **Verify**: `kms` = `True` with `kvAccess` = `Private`, and `diskEncryptionSet` pointing at a customer-managed key. Otherwise etcd secrets are protected only by platform-managed keys you cannot rotate or revoke.
  - **Fix**: `az aks update -g <rg> -n <cluster> --enable-azure-keyvault-kms --azure-keyvault-kms-key-vault-network-access Private --azure-keyvault-kms-key-vault-resource-id <vault-id> --azure-keyvault-kms-key-id <key-uri>`

---

## Monitoring & Activity Logs

- [ ] **Activity Log All Activities** - pass: all eight log categories enabled
  - **Run**: `az monitor diagnostic-settings subscription list --query "value[].{name:name, categories:logs[?enabled].category}" -o json`
  - **Verify**: `categories` includes all eight - `Administrative`, `Security`, `ServiceHealth`, `Alert`, `Recommendation`, `Policy`, `Autoscale`, `ResourceHealth`. A missing `Administrative` or `Policy` category hides exactly the events an attacker generates.
  - **Fix**: run the `create` command from **Enable Subscription Activity Log Diagnostic Settings** below with the same `--name` to overwrite the setting with the full category list. (`az monitor log-profiles` is retired - do not use it.)

- [ ] **Check for Publicly Accessible Activity Log Storage Container** - pass: `allowBlobPublicAccess` = `false` and no container with public access
  - **Run**: `az monitor diagnostic-settings subscription list --query "value[].storageAccountId" -o tsv` then, for each account, `az storage account show --ids <storage-account-id> --query "{name:name, publicBlobAccess:allowBlobPublicAccess, publicNetwork:publicNetworkAccess}"` and `az storage container list --account-name <storage-account> --auth-mode login --query "[?properties.publicAccess!=null].{name:name, access:properties.publicAccess}" -o table`
  - **Verify**: `publicBlobAccess` = `false` and the container query returns **no rows**. The `insights-activity-logs` container holds a record of every control-plane action - anonymous read access hands an attacker your entire tenant map.
  - **Fix**: `az storage account update --ids <storage-account-id> --allow-blob-public-access false` and `az storage container set-permission --name insights-activity-logs --account-name <storage-account> --public-access off --auth-mode login`

- [ ] **Enable Subscription Activity Log Diagnostic Settings** - pass: at least one setting exporting outside the audited subscription
  - **Run**: `az monitor diagnostic-settings subscription list --query "value[].{name:name, workspace:workspaceId, storage:storageAccountId, eventHub:eventHubAuthorizationRuleId}" -o table`
  - **Verify**: at least one setting exists and ships to a Log Analytics workspace (or storage account) **outside** the subscription being audited. No setting means the activity log ages out after 90 days and an attacker's tracks expire on their own.
  - **Fix**: `az monitor diagnostic-settings subscription create --name activity-log-export --location <region> --workspace <workspace-resource-id> --logs '[{"category":"Administrative","enabled":true},{"category":"Security","enabled":true},{"category":"ServiceHealth","enabled":true},{"category":"Alert","enabled":true},{"category":"Recommendation","enabled":true},{"category":"Policy","enabled":true},{"category":"Autoscale","enabled":true},{"category":"ResourceHealth","enabled":true}]'`

---

## App Service

- [ ] **Enable HTTPS-Only Traffic** - pass: `httpsOnly` = `True` and `minTlsVersion` 1.2 or higher
  - **Run**: `az webapp list --query "[].{name:name, rg:resourceGroup, httpsOnly:httpsOnly}" -o table`
  - **Verify**: `httpsOnly` = `True` on every app. Also confirm the TLS floor per app: `az webapp config show -g <rg> -n <app> --query minTlsVersion -o tsv` should return `1.2` or higher.
  - **Fix**: `az webapp update -g <rg> -n <app> --set httpsOnly=true` and `az webapp config set -g <rg> -n <app> --min-tls-version 1.2`

- [ ] **Disable Plain FTP Deployment** - pass: `ftpsState` = `Disabled` on every app
  - **Run**: `az webapp list --query "[].{n:name, g:resourceGroup}" -o tsv | while read n g; do echo "$n: $(az webapp config show -g "$g" -n "$n" --query ftpsState -o tsv)"; done`
  - **Verify**: every app reports `Disabled`. `AllAllowed` sends deployment credentials over plaintext FTP; `FtpsOnly` is the minimum acceptable fallback if a legacy pipeline still needs it.
  - **Fix**: `az webapp config set -g <rg> -n <app> --ftps-state Disabled` and deploy through `az webapp deploy`, GitHub Actions OIDC, or another token-based path instead.

- [ ] **Disable Remote Debugging** - pass: `remoteDebuggingEnabled` = `false` on every app
  - **Run**: `az webapp list --query "[].{n:name, g:resourceGroup}" -o tsv | while read n g; do echo "$n: $(az webapp config show -g "$g" -n "$n" --query remoteDebuggingEnabled -o tsv)"; done`
  - **Verify**: every app reports `false`. Remote debugging attaches a debugger to production and is frequently left on after an incident.
  - **Fix**: `az webapp config set -g <rg> -n <app> --remote-debugging-enabled false`

- [ ] **Enable App Service Authentication** - pass: `platform.enabled` = `true` on every non-public app
  - **Run**: `az webapp list --query "[].{n:name, g:resourceGroup}" -o tsv | while read n g; do echo "$n: $(az webapp auth show -g "$g" -n "$n" --query "platform.enabled" -o tsv)"; done`
  - **Verify**: `true` for every app that is not intentionally public. This is the platform-level gate that runs before your own code, so it still holds if an application-layer auth check regresses.
  - **Fix**: `az webapp auth update -g <rg> -n <app> --enabled true --action LoginWithAzureActiveDirectory --unauthenticated-client-action RedirectToLoginPage`

- [ ] **Use Key Vaults to Store App Service Application Secrets** - pass: no secret-shaped setting holds a literal value
  - **Run**: `az webapp list --query "[].{n:name, g:resourceGroup}" -o tsv | while read n g; do echo "== $n"; az webapp config appsettings list -g "$g" -n "$n" --query "[?!starts_with(value, '@Microsoft.KeyVault')].name" -o tsv; done`
  - **Verify**: no setting whose name suggests a secret (`*KEY*`, `*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*CONNECTIONSTRING*`, `*PRIVATE*`) appears in the output. Anything listed is a literal value readable by everyone with Contributor on the app, and it shows up in exports and ARM templates.
  - **Fix**: store the value with `az keyvault secret set --vault-name <vault> --name <secret> --value <value>`, give the app a managed identity (`az webapp identity assign -g <rg> -n <app>`), grant it **Key Vault Secrets User**, then replace the setting with `az webapp config appsettings set -g <rg> -n <app> --settings <NAME>="@Microsoft.KeyVault(SecretUri=<secret-uri>)"`. Rotate every secret that was previously stored in plaintext.
