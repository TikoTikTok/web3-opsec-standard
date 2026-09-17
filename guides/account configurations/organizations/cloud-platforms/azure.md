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

Each item states its **pass** condition, then gives **Console** (the Azure portal or Entra admin center) and **CLI** (the Azure CLI and Microsoft Graph) steps to **Verify** and **Fix** it. Under CLI, **Expect** is the output that means it passes. Pick the channel you work in at the top of the guide; an item shows only the channels that can check or change the setting, and it passes only when every resource the command returns meets the condition.

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
  - **Console**:
    - Verify: Entra admin center > Protection > Authentication methods > Monitoring > User registration details > add filter `Is admin?` = Yes > every row shows `MFA registered` = Yes and `Methods registered` includes `Passkey (FIDO2)`, `Windows Hello for Business` or a device-bound passkey
    - Fix: Entra admin center > Protection > Conditional Access > Policies > New policy > Users > Select users and groups > Directory roles > pick every privileged role and exclude one break-glass account > Target resources > All resources > Grant > Require authentication strength > Phishing-resistant MFA > Enable policy > On > Create
  - **CLI**:
    - Verify:
      ```bash
      az rest --method GET \
        --uri "https://graph.microsoft.com/v1.0/reports/authenticationMethods/userRegistrationDetails" \
        --query "value[?isAdmin].{upn:userPrincipalName, mfaRegistered:isMfaRegistered, methods:methodsRegistered}" -o table
      ```
    - Expect: every row has `mfaRegistered` = `True` and `methods` contains `fido2`, `windowsHelloForBusiness` or `passKeyDeviceBound`. A row listing only `sms` or `voice` is a fail: those methods are SIM-swap prone.
    - Fix:
      ```bash
      az rest --method POST --uri "https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies" \
        --body '{
          "displayName": "Require phishing-resistant MFA for privileged roles",
          "state": "enabledForReportingButNotEnforced",
          "conditions": {
            "users": {
              "includeRoles": [
                "62e90394-69f5-4237-9190-012177145e10", "e8611ab8-c189-46e8-94e1-60213ab1f814",
                "194ae4cb-b126-40b2-bd5b-6091b380977d", "fe930be7-5e62-47db-91af-98c3a49a38b1",
                "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3", "158c047a-c907-4556-b7ef-446551a6b5f7",
                "b1be1c3e-b65d-4f19-8427-f6fa0d97feb9", "7be44c8a-adaf-4e2a-84d6-ab2649e08a13"
              ],
              "excludeUsers": ["<break-glass-object-id>"]
            },
            "applications": {"includeApplications": ["All"]}
          },
          "grantControls": {
            "operator": "OR",
            "authenticationStrength": {"id": "00000000-0000-0000-0000-000000000004"}
          }
        }'
      ```
    - Fix:
      ```bash
      az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies/<policy-id>" \
        --body '{"state": "enabled"}'
      ```

- [ ] **Enable Multi-Factor Authentication for Non-Privileged Users** - pass: the query returns no rows
  - **Console**:
    - Verify: Entra admin center > Protection > Authentication methods > Monitoring > User registration details > add filters `Is admin?` = No and `MFA registered` = No > the list is empty
    - Fix: Entra admin center > Protection > Conditional Access > Policies > New policy > Users > All users > exclude one break-glass account > Target resources > All resources > Grant > Require multifactor authentication > Enable policy > Report-only > Create; after reviewing Entra admin center > Identity > Monitoring & health > Sign-in logs, open the policy and set Enable policy > On > Save
  - **CLI**:
    - Verify:
      ```bash
      az rest --method GET \
        --uri "https://graph.microsoft.com/v1.0/reports/authenticationMethods/userRegistrationDetails" \
        --query "value[?!isAdmin && !isMfaRegistered].{upn:userPrincipalName, type:userType}" -o table
      ```
    - Expect: no rows. Any row is a member or guest who can sign in with a password alone.
    - Fix:
      ```bash
      az rest --method POST --uri "https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies" \
        --body '{
          "displayName": "Require MFA for all users",
          "state": "enabledForReportingButNotEnforced",
          "conditions": {
            "users": {"includeUsers": ["All"], "excludeUsers": ["<break-glass-object-id>"]},
            "applications": {"includeApplications": ["All"]}
          },
          "grantControls": {"operator": "OR", "builtInControls": ["mfa"]}
        }'
      ```
    - Fix:
      ```bash
      az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies/<policy-id>" \
        --body '{"state": "enabled"}'
      ```

- [ ] **Enable Security Defaults** - pass: `isEnabled` = `true`, or `false` where Conditional Access covers MFA instead
  - **Console**:
    - Verify: Entra admin center > Identity > Overview > Properties > Manage security defaults > the `Security defaults` dropdown reads `Enabled` (or `Disabled` on a tenant where Conditional Access enforces MFA)
    - Fix: Entra admin center > Identity > Overview > Properties > Manage security defaults > Security defaults > `Enabled` > Save
  - **CLI**:
    - Verify:
      ```bash
      az rest --method GET \
        --uri "https://graph.microsoft.com/v1.0/policies/identitySecurityDefaultsEnforcementPolicy" \
        --query "{securityDefaults:isEnabled}"
      ```
    - Expect: `securityDefaults` = `true` on a tenant with no Entra ID P1/P2 licence, or `false` on a tenant that uses Conditional Access (the two are mutually exclusive, so the two MFA items above must then pass). A tenant with neither has no MFA baseline at all.
    - Fix:
      ```bash
      az rest --method PATCH \
        --uri "https://graph.microsoft.com/v1.0/policies/identitySecurityDefaultsEnforcementPolicy" \
        --body '{"isEnabled": true}'
      ```

- [ ] **Require Multi-Factor Auth To Join Devices** - pass: `multiFactorAuthConfiguration` = `required`
  - **Console**:
    - Verify: Entra admin center > Identity > Devices > Overview > Device settings > `Require Multifactor Authentication to register or join devices with Microsoft Entra` reads Yes
    - Fix: Entra admin center > Identity > Devices > Overview > Device settings > Require Multifactor Authentication to register or join devices with Microsoft Entra > Yes > Save (preferred alternative: Entra admin center > Protection > Conditional Access > Policies > New policy > Target resources > User actions > Register or join devices > Grant > Require multifactor authentication)
  - **CLI**:
    - Verify:
      ```bash
      az rest --method GET --uri "https://graph.microsoft.com/v1.0/policies/deviceRegistrationPolicy" \
        --query "{mfa:multiFactorAuthConfiguration, quota:userDeviceQuota}"
      ```
    - Expect: `mfa` = `required` (if v1.0 returns an error, retry the same path against `https://graph.microsoft.com/beta/`). `notRequired` means an attacker with a stolen password can enrol their own device into the tenant.

- [ ] **Restrict Access To Microsoft Entra ID Administration Portal** - pass: portal toggle reads **Yes** - there is no CLI equivalent
  - **Console**:
    - Verify: Entra admin center > Identity > Users > User settings > `Restrict access to Microsoft Entra admin center` reads Yes
    - Fix: Entra admin center > Identity > Users > User settings > Restrict access to Microsoft Entra admin center > Yes > Save. This blocks the admin center UI only; it is a reconnaissance control, not an authorization boundary, so pair it with least-privilege role assignments.

- [ ] **Guests Can Invite** - pass: `allowInvitesFrom` is not `everyone`
  - **Console**:
    - Verify: Entra admin center > Identity > External Identities > External collaboration settings > Guest invite settings > the selected option is not `Anyone in the organization can invite guest users including guests and non-admins (most inclusive)`
    - Fix: Entra admin center > Identity > External Identities > External collaboration settings > Guest invite settings > select `Only users assigned to specific admin roles can invite guest users` > Save
  - **CLI**:
    - Verify:
      ```bash
      az rest --method GET --uri "https://graph.microsoft.com/v1.0/policies/authorizationPolicy" \
        --query "allowInvitesFrom"
      ```
    - Expect: any value other than `everyone`. `everyone` lets an existing guest invite further guests, so one compromised external account can grow its own foothold.
    - Fix:
      ```bash
      az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/policies/authorizationPolicy" \
        --body '{"allowInvitesFrom": "adminsAndGuestInviters"}'
      ```

- [ ] **Members Can Invite** - pass: `allowInvitesFrom` = `adminsAndGuestInviters` or `none`
  - **Console**:
    - Verify: Entra admin center > Identity > External Identities > External collaboration settings > Guest invite settings > the selected option is `Only users assigned to specific admin roles can invite guest users` or `No one in the organization can invite guest users including admins (most restrictive)`
    - Fix: Entra admin center > Identity > External Identities > External collaboration settings > Guest invite settings > select `Only users assigned to specific admin roles can invite guest users` > Save; then Entra admin center > Identity > Roles & admins > Guest Inviter > Add assignments > add only the people who need to invite
  - **CLI**:
    - Verify:
      ```bash
      az rest --method GET --uri "https://graph.microsoft.com/v1.0/policies/authorizationPolicy" \
        --query "allowInvitesFrom"
      ```
    - Expect: `adminsAndGuestInviters` or `none`. `adminsGuestInvitersAndAllMembers` and `everyone` both allow any employee to add an external identity without review.
    - Fix:
      ```bash
      az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/policies/authorizationPolicy" \
        --body '{"allowInvitesFrom": "adminsAndGuestInviters"}'
      ```

- [ ] **Check for Microsoft Entra ID Guest Users** - pass: every guest is a current, named collaborator with a business reason
  - **Console**:
    - Verify: Entra admin center > Identity > Users > All users > Add filter > `User type` = Guest > every listed guest is a current, named external collaborator with a business reason
    - Fix: Entra admin center > Identity > Users > All users > select each stale guest > Delete > Yes; then Entra admin center > Identity > External Identities > External collaboration settings > Guest user access > select `Guest user access is restricted to properties and memberships of their own directory objects (most restrictive)` > Save; then Entra admin center > Identity governance > Access reviews > New access review > scope to guest users on a recurring schedule > Start
  - **CLI**:
    - Verify:
      ```bash
      az ad user list --filter "userType eq 'Guest'" \
        --query "[].{name:displayName, upn:userPrincipalName, mail:mail}" -o table
      ```
    - Expect: every guest is a current, named external collaborator with a business reason. Guests from finished engagements are a fail: they keep whatever group memberships they were given.
    - Fix: `az ad user delete --id <user-principal-name>`
    - Fix:
      ```bash
      az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/policies/authorizationPolicy" \
        --body '{"guestUserRoleId": "2af84b1e-32c8-42b7-82bc-daa82404023b"}'
      ```

- [ ] **Disable Tenant Creation for Non-Admin Users** - pass: `allowedToCreateTenants` = `false`
  - **Console**:
    - Verify: Entra admin center > Identity > Users > User settings > `Restrict non-admin users from creating tenants` reads Yes
    - Fix: Entra admin center > Identity > Users > User settings > Restrict non-admin users from creating tenants > Yes > Save
  - **CLI**:
    - Verify:
      ```bash
      az rest --method GET --uri "https://graph.microsoft.com/v1.0/policies/authorizationPolicy" \
        --query "defaultUserRolePermissions.allowedToCreateTenants"
      ```
    - Expect: `false`. When `true`, any user can spin up a tenant they are Global Admin of, which is unmonitored infrastructure carrying your company identity.
    - Fix:
      ```bash
      az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/policies/authorizationPolicy" \
        --body '{"defaultUserRolePermissions": {"allowedToCreateTenants": false}}'
      ```

- [ ] **Users Can Register Applications** - pass: `allowedToCreateApps` = `false`
  - **Console**:
    - Verify: Entra admin center > Identity > Users > User settings > `Users can register applications` reads No
    - Fix: Entra admin center > Identity > Users > User settings > Users can register applications > No > Save; then Entra admin center > Identity > Roles & admins > Application Developer > Add assignments > add only the people who genuinely need it
  - **CLI**:
    - Verify:
      ```bash
      az rest --method GET --uri "https://graph.microsoft.com/v1.0/policies/authorizationPolicy" \
        --query "defaultUserRolePermissions.allowedToCreateApps"
      ```
    - Expect: `false`. App registration by standard users creates credentials that outlive the user's account and are rarely reviewed.
    - Fix:
      ```bash
      az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/policies/authorizationPolicy" \
        --body '{"defaultUserRolePermissions": {"allowedToCreateApps": false}}'
      ```

- [ ] **Users Can Consent To Apps Accessing Company Data On Their Behalf** - pass: `permissionGrantPoliciesAssigned` is empty, or low-risk only
  - **Console**:
    - Verify: Entra admin center > Identity > Applications > Enterprise applications > Consent and permissions > User consent settings > `User consent for applications` reads `Do not allow user consent` (or `Allow user consent for apps from verified publishers, for selected permissions`)
    - Fix: Entra admin center > Identity > Applications > Enterprise applications > Consent and permissions > User consent settings > select `Do not allow user consent` > Save; then Entra admin center > Identity > Applications > Enterprise applications > Consent and permissions > Admin consent settings > Users can request admin consent to apps they are unable to consent to > Yes > pick reviewers > Save
  - **CLI**:
    - Verify:
      ```bash
      az rest --method GET --uri "https://graph.microsoft.com/v1.0/policies/authorizationPolicy" \
        --query "defaultUserRolePermissions.permissionGrantPoliciesAssigned"
      ```
    - Expect: an empty array (`[]`, consent disabled) or only `ManagePermissionGrantsForSelf.microsoft-user-default-low`. `ManagePermissionGrantsForSelf.microsoft-user-default-legacy` is a fail: it is the setting illicit-consent phishing relies on.
    - Fix:
      ```bash
      az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/policies/authorizationPolicy" \
        --body '{"defaultUserRolePermissions": {"permissionGrantPoliciesAssigned": []}}'
      ```

- [ ] **Multi-factor Authentication On Devices** - pass: `Fido2` and `MicrosoftAuthenticator` enabled; `Sms`, `Voice`, `Email` disabled
  - **Console**:
    - Verify: Entra admin center > Protection > Authentication methods > Policies > the method table shows `Passkey (FIDO2)` and `Microsoft Authenticator` as Enabled and `SMS`, `Voice call` and `Email OTP` as Disabled
    - Fix: Entra admin center > Protection > Authentication methods > Policies > select each of `Passkey (FIDO2)` and `Microsoft Authenticator` > Enable > On > Save; then select each of `SMS`, `Voice call` and `Email OTP` > Enable > Off > Save, after confirming no user depends on them
  - **CLI**:
    - Verify:
      ```bash
      az rest --method GET --uri "https://graph.microsoft.com/v1.0/policies/authenticationMethodsPolicy" \
        --query "authenticationMethodConfigurations[].{method:id, state:state}" -o table
      ```
    - Expect: `Fido2` and `MicrosoftAuthenticator` are `enabled`; `Sms`, `Voice` and `Email` are `disabled`. Leaving SMS or voice enabled means the weakest method is the one an attacker will target.
    - Fix:
      ```bash
      base="https://graph.microsoft.com/v1.0/policies/authenticationMethodsPolicy/authenticationMethodConfigurations"
      az rest --method PATCH --uri "$base/Fido2" \
        --body '{"@odata.type": "#microsoft.graph.fido2AuthenticationMethodConfiguration", "state": "enabled"}'
      az rest --method PATCH --uri "$base/MicrosoftAuthenticator" \
        --body '{"@odata.type": "#microsoft.graph.microsoftAuthenticatorAuthenticationMethodConfiguration", "state": "enabled"}'
      az rest --method PATCH --uri "$base/Sms" \
        --body '{"@odata.type": "#microsoft.graph.smsAuthenticationMethodConfiguration", "state": "disabled"}'
      az rest --method PATCH --uri "$base/Voice" \
        --body '{"@odata.type": "#microsoft.graph.voiceAuthenticationMethodConfiguration", "state": "disabled"}'
      az rest --method PATCH --uri "$base/Email" \
        --body '{"@odata.type": "#microsoft.graph.emailAuthenticationMethodConfiguration", "state": "disabled"}'
      ```

---

## Virtual Machines

- [ ] **Disable Public Network Access to Virtual Machine Disks** - pass: `publicNetworkAccess` = `Disabled` and `networkAccessPolicy` = `DenyAll`
  - **Console**:
    - Verify: Azure portal > Disks > <disk> > Settings > Networking > `Network access` reads `Disable public and private access` (or `Disable public access and enable private access` when a disk access resource is attached)
    - Fix: Azure portal > Disks > <disk> > Settings > Networking > Network access > select `Disable public and private access` > Save
  - **CLI**:
    - Verify:
      ```bash
      az disk list \
        --query "[].{name:name, rg:resourceGroup, publicAccess:publicNetworkAccess, policy:networkAccessPolicy}" -o table
      ```
    - Expect: every disk shows `publicAccess` = `Disabled` and `policy` = `DenyAll` (or `AllowPrivate` when a disk access resource is attached). `AllowAll` means a leaked SAS URL exports the whole disk over the internet.
    - Fix:
      ```bash
      az disk update --name <disk> --resource-group <rg> \
        --public-network-access Disabled --network-access-policy DenyAll
      ```

- [ ] **Disable Public IP Address Assignment for VMSS Instances** - pass: `publicIPAddressConfiguration` is null on every scale set
  - **Console**:
    - Verify: Azure portal > Virtual machine scale sets > <scale set> > Settings > Networking > Network Interface tab > the `Public IP address` column is empty for every IP configuration
    - Fix: Azure portal > Virtual machine scale sets > <scale set> > Settings > Networking > Network Interface tab > select the IP configuration > Public IP address > Disabled > Save; then Azure portal > Virtual machine scale sets > <scale set> > Settings > Instances > select all > Upgrade; route outbound traffic through a NAT gateway on the subnet and administer instances through Azure Bastion
  - **CLI**:
    - Verify:
      ```bash
      az vmss list \
        --query "[].{name:name, rg:resourceGroup, publicIp:virtualMachineProfile.networkProfile.networkInterfaceConfigurations[].ipConfigurations[].publicIPAddressConfiguration}" -o json
      ```
    - Expect: `publicIp` is `null` or an empty list for every scale set. A non-null value means each instance gets its own internet-routable address, multiplying the attack surface with every scale-out.
    - Fix:
      ```bash
      az vmss update -g <rg> -n <scale-set> \
        --remove virtualMachineProfile.networkProfile.networkInterfaceConfigurations[0].ipConfigurations[0].publicIPAddressConfiguration
      az vmss update-instances -g <rg> -n <scale-set> --instance-ids "*"
      ```

- [ ] **Check for SSH Authentication Type** - pass: `disablePasswordAuthentication` = `True` on every Linux VM
  - **Console**:
    - Verify: Azure portal > Virtual machines > <vm> > Overview > JSON View > `properties.osProfile.linuxConfiguration.disablePasswordAuthentication` reads `true` on every Linux VM
    - Fix: Azure portal > Virtual machines > <vm> > Operations > Run command > RunShellScript > paste `sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && systemctl restart sshd` > Run, after confirming key-based login works in a second session
  - **CLI**:
    - Verify:
      ```bash
      az vm list \
        --query "[?storageProfile.osDisk.osType=='Linux'].{name:name, rg:resourceGroup, passwordAuthDisabled:osProfile.linuxConfiguration.disablePasswordAuthentication}" -o table
      ```
    - Expect: `passwordAuthDisabled` = `True` on every Linux VM. `False` or blank means SSH password brute force is in scope.
    - Fix:
      ```bash
      az vm run-command invoke -g <rg> -n <vm> --command-id RunShellScript \
        --scripts "sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && systemctl restart sshd"
      ```

- [ ] **Enable Just-In-Time Access for Virtual Machines** - pass: every VM with an open management port appears in a JIT policy
  - **Console**:
    - Verify: Azure portal > Microsoft Defender for Cloud > Cloud Security > Workload protections > Just-in-time VM access > Configured tab lists every VM that exposes port 22, 3389, 5985 or 5986, and none of them appear on the Not configured tab
    - Fix: Azure portal > Microsoft Defender for Cloud > Cloud Security > Workload protections > Just-in-time VM access > Not configured tab > select the VM > Enable JIT on 1 VM > set the request window to 1-3 hours > Save (requires the Defender for Servers Plan 2 plan)
  - **CLI**:
    - Verify:
      ```bash
      az rest --method GET \
        --uri "https://management.azure.com/subscriptions/$(az account show --query id -o tsv)/providers/Microsoft.Security/jitNetworkAccessPolicies?api-version=2020-01-01" \
        --query "value[].{name:name, vms:properties.virtualMachines[].id}" -o json
      ```
    - Expect: every VM that exposes a management port (22, 3389, 5985, 5986) appears in the `vms` list of a policy. A VM with an open management port and no JIT policy is permanently reachable.
    - Fix:
      ```bash
      az rest --method PUT \
        --uri "https://management.azure.com/subscriptions/$(az account show --query id -o tsv)/resourceGroups/<rg>/providers/Microsoft.Security/locations/<region>/jitNetworkAccessPolicies/default?api-version=2020-01-01" \
        --body '{
          "kind": "Basic",
          "properties": {
            "virtualMachines": [{
              "id": "<vm-resource-id>",
              "ports": [{"number": 22, "protocol": "TCP", "allowedSourceAddressPrefix": "*", "maxRequestAccessDuration": "PT3H"}]
            }]
          }
        }'
      ```

- [ ] **Enable System-Assigned Managed Identities** - pass: `identity.type` includes `SystemAssigned`
  - **Console**:
    - Verify: Azure portal > Virtual machines > <vm> > Security > Identity > System assigned tab > `Status` reads On for every VM that calls an Azure service
    - Fix: Azure portal > Virtual machines > <vm> > Security > Identity > System assigned tab > Status > On > Save > Yes; then Azure role assignments > Add role assignment > pick the narrowest role and scope > Save; then delete the static secrets the identity replaces
  - **CLI**:
    - Verify: `az vm list --query "[].{name:name, rg:resourceGroup, identity:identity.type}" -o table`
    - Expect: `identity` contains `SystemAssigned` on every VM that calls an Azure service. A blank value means the workload is authenticating with a static secret stored somewhere on the box.
    - Fix: `az vm identity assign -g <rg> -n <vm>`
    - Fix: `az role assignment create --assignee <principal-id> --role <role> --scope <resource-id>`

- [ ] **Enable Virtual Machine Access using Microsoft Entra ID Authentication** - pass: `AADSSHLoginForLinux` or `AADLoginForWindows` installed on every VM
  - **Console**:
    - Verify: Azure portal > Virtual machines > <vm> > Settings > Extensions + applications > Extensions tab > the list includes `AADSSHLoginForLinux` (Linux) or `AADLoginForWindows` (Windows) with status `Provisioning succeeded`
    - Fix: Azure portal > Virtual machines > <vm> > Settings > Extensions + applications > Extensions tab > Add > `Azure AD based SSH Login` (Linux) or `Azure AD based Windows Login` (Windows) > Next > Review + create > Create; then Azure portal > Virtual machines > <vm> > Access control (IAM) > Add > Add role assignment > `Virtual Machine Administrator Login` or `Virtual Machine User Login` > the right Entra groups > Review + assign
  - **CLI**:
    - Verify:
      ```bash
      az vm list --query "[].{n:name, g:resourceGroup}" -o tsv | while read n g; do
        echo "$n: $(az vm extension list -g "$g" --vm-name "$n" --query "[].name" -o tsv | tr '\n' ' ')"
      done
      ```
    - Expect: each VM lists `AADSSHLoginForLinux` (Linux) or `AADLoginForWindows` (Windows). Without it, access depends on local accounts and SSH keys that survive offboarding.
    - Fix:
      ```bash
      az vm extension set --publisher Microsoft.Azure.ActiveDirectory --name AADSSHLoginForLinux \
        -g <rg> --vm-name <vm>
      az role assignment create --assignee <group-object-id> --role "Virtual Machine User Login" \
        --scope "$(az vm show -g <rg> -n <vm> --query id -o tsv)"
      ```

- [ ] **Install Approved Extensions Only** - pass: every installed extension is on your approved list
  - **Console**:
    - Verify: Azure portal > Virtual machines > <vm> > Settings > Extensions + applications > Extensions tab > every listed extension name and publisher is on your approved list (monitoring, Entra login, Defender, backup agents)
    - Fix: Azure portal > Virtual machines > <vm> > Settings > Extensions + applications > Extensions tab > select the unexpected extension > Uninstall > Yes; then Azure portal > Policy > Authoring > Definitions > search `Only approved VM extensions should be installed` > Assign > Parameters > enter the approved extension list > Review + create > Create
  - **CLI**:
    - Verify:
      ```bash
      az vm list --query "[].{n:name, g:resourceGroup}" -o tsv | while read n g; do
        az vm extension list -g "$g" --vm-name "$n" --query "[].{vm:'$n', ext:name, publisher:publisher}" -o tsv
      done
      ```
    - Expect: every extension matches your approved list (monitoring, Entra login, Defender, backup agents). Extensions run as root/SYSTEM, so an unexpected one is a code-execution path.
    - Fix: `az vm extension delete -g <rg> --vm-name <vm> -n <extension-name>`
    - Fix:
      ```bash
      az policy assignment create --name approved-vm-extensions \
        --policy c0e996f8-39cf-4af9-9f45-83fbde810432 \
        --params '{"approvedExtensions": {"value": ["<extension-name>", "<extension-name>"]}}'
      ```

---

## Key Vault

- [ ] **Restrict Default Network Access for Azure Key Vaults** - pass: `defaultAction` = `Deny` and `publicNetworkAccess` = `Disabled`
  - **Console**:
    - Verify: Azure portal > Key vaults > <vault> > Settings > Networking > Firewalls and virtual networks tab > `Allow access from` reads `Disable public access`
    - Fix: Azure portal > Key vaults > <vault> > Settings > Networking > Firewalls and virtual networks tab > Allow access from > select `Disable public access` > Apply (if some addresses must reach the vault over the internet, select `Allow public access from specific virtual networks and IP addresses` and add only those addresses instead)
  - **CLI**:
    - Verify:
      ```bash
      az keyvault list \
        --query "[].{name:name, rg:resourceGroup, defaultAction:properties.networkAcls.defaultAction, bypass:properties.networkAcls.bypass, publicAccess:properties.publicNetworkAccess}" -o table
      ```
    - Expect: `defaultAction` = `Deny` and `publicAccess` = `Disabled` on every vault. `Allow` means a stolen token can be redeemed for your secrets from anywhere on the internet.
    - Fix: `az keyvault network-rule add --name <vault> --ip-address <cidr>`
    - Fix: `az keyvault update --name <vault> --default-action Deny --public-network-access Disabled`

- [ ] **Use Private Endpoints for Key Vaults** - pass: at least one private endpoint connection in state `Approved`
  - **Console**:
    - Verify: Azure portal > Key vaults > <vault> > Settings > Networking > Private endpoint connections tab > at least one connection shows `Connection state` = Approved
    - Fix: Azure portal > Key vaults > <vault> > Settings > Networking > Private endpoint connections tab > Create > pick the virtual network and subnet > Target sub-resource `vault` > DNS > Integrate with private DNS zone `privatelink.vaultcore.azure.net` > Yes > Review + create > Create
  - **CLI**:
    - Verify:
      ```bash
      az keyvault list \
        --query "[].{name:name, rg:resourceGroup, endpoints:properties.privateEndpointConnections[].privateLinkServiceConnectionState.status}" -o table
      ```
    - Expect: each vault has at least one connection in state `Approved`. An empty `endpoints` column means vault traffic leaves your virtual network.
    - Fix:
      ```bash
      az network private-endpoint create --name <pe-name> -g <rg> --vnet-name <vnet> --subnet <subnet> \
        --private-connection-resource-id "$(az keyvault show --name <vault> --query id -o tsv)" \
        --group-id vault --connection-name <conn-name>
      az network private-dns zone create -g <rg> -n privatelink.vaultcore.azure.net
      az network private-dns link vnet create -g <rg> -n <link-name> -z privatelink.vaultcore.azure.net \
        -v <vnet> --registration-enabled false
      az network private-endpoint dns-zone-group create -g <rg> --endpoint-name <pe-name> -n default \
        --private-dns-zone privatelink.vaultcore.azure.net --zone-name vault
      ```

- [ ] **Enable Role-Based Access Control (RBAC) Authorization** - pass: `enableRbacAuthorization` = `True` on every vault
  - **Console**:
    - Verify: Azure portal > Key vaults > <vault> > Settings > Access configuration > `Permission model` reads `Azure role-based access control`
    - Fix: Azure portal > Key vaults > <vault> > Access control (IAM) > Add > Add role assignment > grant `Key Vault Secrets User` / `Key Vault Crypto User` to every current consumer > Review + assign; then Azure portal > Key vaults > <vault> > Settings > Access configuration > Permission model > `Azure role-based access control` > Apply
  - **CLI**:
    - Verify: `az keyvault list --query "[].{name:name, rbac:properties.enableRbacAuthorization}" -o table`
    - Expect: `rbac` = `True` on every vault. Legacy access policies cannot be reviewed alongside the rest of your Azure role assignments, so over-grants go unnoticed.
    - Fix:
      ```bash
      az role assignment create --assignee <principal-id> --role "Key Vault Secrets User" \
        --scope <vault-id>
      ```
    - Fix: `az keyvault update --name <vault> --enable-rbac-authorization true`

- [ ] **Check for Key Vault Full Administrator Permissions** - pass: only named break-glass identities hold Administrator, Owner or Contributor
  - **Console**:
    - Verify: Azure portal > Key vaults > <vault> > Access control (IAM) > Role assignments tab > filter Role to `Key Vault Administrator`, `Owner` and `Contributor` > only named break-glass identities are listed, and on access-policy vaults Azure portal > Key vaults > <vault> > Access policies shows no principal holding every key, secret and certificate permission
    - Fix: Azure portal > Key vaults > <vault> > Access control (IAM) > Role assignments tab > select the over-privileged assignment > Remove > Yes; then Add > Add role assignment > `Key Vault Secrets User` > the same principal > Review + assign
  - **CLI**:
    - Verify:
      ```bash
      az keyvault list --query "[].id" -o tsv | while read id; do
        echo "== $id"
        az role assignment list --scope "$id" --include-inherited \
          --query "[?contains(roleDefinitionName, 'Administrator') || roleDefinitionName=='Owner' || roleDefinitionName=='Contributor'].{principal:principalName, role:roleDefinitionName}" -o tsv
      done
      ```
    - Verify:
      ```bash
      az keyvault show --name <vault> \
        --query "properties.accessPolicies[].{objectId:objectId, permissions:permissions}" -o json
      ```
    - Expect: only named break-glass identities hold `Key Vault Administrator`, `Owner` or `Contributor`, and no access policy grants all secret, key and certificate operations. Applications and CI should never appear here, because a full-admin credential turns any app compromise into a vault-wide leak.
    - Fix:
      ```bash
      az role assignment delete --assignee <principal-id> --role "Key Vault Administrator" --scope <vault-id>
      az role assignment create --assignee <principal-id> --role "Key Vault Secrets User" --scope <vault-id>
      ```

- [ ] **Ensure Purge Protection is Enabled for Key Vaults** - pass: `enablePurgeProtection` = `True` with 90-day retention
  - **Console**:
    - Verify: Azure portal > Key vaults > <vault> > Settings > Properties > `Purge protection` reads `Enable purge protection` and `Days to retain deleted vaults` reads 90
    - Fix: Azure portal > Key vaults > <vault> > Settings > Properties > Purge protection > select `Enable purge protection (enforce a mandatory retention period for deleted vaults and vault objects)` > Save (irreversible: once on, a deleted vault cannot be purged before the retention window expires)
  - **CLI**:
    - Verify:
      ```bash
      az keyvault list \
        --query "[].{name:name, purgeProtection:properties.enablePurgeProtection, retentionDays:properties.softDeleteRetentionInDays}" -o table
      ```
    - Expect: `purgeProtection` = `True` and `retentionDays` = `90` on every vault. Without it, an attacker with vault-delete rights can permanently destroy your keys and any data they encrypt.
    - Fix: `az keyvault update --name <vault> --enable-purge-protection true`

- [ ] **Enable Key Vault Recoverability** - pass: `enableSoftDelete` = `True` and `softDeleteRetentionInDays` = `90`
  - **Console**:
    - Verify: Azure portal > Key vaults > <vault> > Settings > Properties > `Soft-delete` reads Enabled and `Days to retain deleted vaults` reads 90; and Azure portal > Key vaults > Manage deleted vaults > no vault is sitting deleted and forgotten
    - Fix: Azure portal > Key vaults > <vault> > Settings > Properties > Days to retain deleted vaults > 90 > Save; recover an accidentally deleted vault at Azure portal > Key vaults > Manage deleted vaults > select the subscription > select the vault > Recover
  - **CLI**:
    - Verify:
      ```bash
      az keyvault list \
        --query "[].{name:name, softDelete:properties.enableSoftDelete, retentionDays:properties.softDeleteRetentionInDays}" -o table
      ```
    - Verify:
      ```bash
      az keyvault list-deleted \
        --query "[].{name:name, scheduledPurge:properties.scheduledPurgeDate}" -o table
      ```
    - Expect: `softDelete` = `True` with `retentionDays` = `90` on every vault, and the deleted list holds nothing unexpected. A vault without soft delete is gone the moment a mistaken or malicious delete lands.
    - Fix: `az keyvault update --name <vault> --retention-days 90`
    - Fix: `az keyvault recover --name <vault>`

- [ ] **Azure Key Vault Cross-Subscription Access** - pass: every vault and access-policy `tenantId` matches your own
  - **Console**:
    - Verify: Azure portal > Key vaults > <vault> > Overview > `Directory ID` matches your own tenant ID, and Azure portal > Key vaults > <vault> > Access policies > every principal resolves to a user, group or application in your own directory
    - Fix: Azure portal > Key vaults > <vault> > Access policies > select the foreign principal > Delete > Save; for RBAC vaults Azure portal > Key vaults > <vault> > Access control (IAM) > Role assignments tab > select the foreign principal > Remove > Yes; then Entra admin center > Identity > External Identities > Cross-tenant access settings > Default settings > B2B collaboration > Inbound access > Edit inbound defaults > block access for external users and groups > Save
  - **CLI**:
    - Verify: `az account show --query tenantId -o tsv`
    - Verify:
      ```bash
      az keyvault list \
        --query "[].{name:name, vaultTenant:properties.tenantId, policyTenants:properties.accessPolicies[].tenantId}" -o json
      ```
    - Expect: every `vaultTenant` and every entry in `policyTenants` equals the tenant ID from the first command. A foreign tenant ID in an access policy is a live data path out of your environment.
    - Fix: `az keyvault delete-policy --name <vault> --object-id <object-id>`
    - Fix: `az role assignment delete --assignee <object-id> --scope <vault-id>`

---

## Kubernetes (AKS)

- [ ] **Disable Public FQDN for Private AKS Clusters** - pass: `enablePrivateClusterPublicFqdn` = `False` on private clusters
  - **Console**:
    - Verify: Azure portal > Kubernetes services > <cluster> > Overview > JSON View > on every cluster where `properties.apiServerAccessProfile.enablePrivateCluster` is `true`, `properties.apiServerAccessProfile.enablePrivateClusterPublicFqdn` reads `false`
    - Fix: Azure portal > Cloud Shell (top bar) > run `az aks update -g <rg> -n <cluster> --disable-public-fqdn`
  - **CLI**:
    - Verify:
      ```bash
      az aks list \
        --query "[].{name:name, rg:resourceGroup, private:apiServerAccessProfile.enablePrivateCluster, publicFqdn:apiServerAccessProfile.enablePrivateClusterPublicFqdn}" -o table
      ```
    - Expect: on every cluster with `private` = `True`, `publicFqdn` is `False` or blank. A public FQDN on a private cluster publishes the API server's resolvable name back to the internet.
    - Fix: `az aks update -g <rg> -n <cluster> --disable-public-fqdn`

- [ ] **Enable Kubernetes Role-Based Access Control** - pass: `enableRbac` = `True` on every cluster
  - **Console**:
    - Verify: Azure portal > Kubernetes services > <cluster> > Overview > JSON View > `properties.enableRBAC` reads `true`
    - Fix: Azure portal > Kubernetes services > Create > Kubernetes cluster > Access tab > Authentication and Authorization > any option that includes Kubernetes RBAC or Azure RBAC > Review + create > Create, then migrate workloads (RBAC cannot be enabled on an existing cluster)
  - **CLI**:
    - Verify: `az aks list --query "[].{name:name, rg:resourceGroup, k8sRbac:enableRbac}" -o table`
    - Expect: `k8sRbac` = `True` on every cluster. Without it, any authenticated principal is effectively cluster-admin.
    - Fix: `az aks create -g <rg> -n <new-cluster> --enable-rbac --enable-aad --enable-azure-rbac`

- [ ] **Enable Azure Role-Based Access Control (RBAC) for Kubernetes Authorization** - pass: `aadProfile.enableAzureRbac` = `True`
  - **Console**:
    - Verify: Azure portal > Kubernetes services > <cluster> > Settings > Cluster configuration > `Authentication and Authorization` reads `Microsoft Entra ID authentication with Azure RBAC`
    - Fix: Azure portal > Kubernetes services > <cluster> > Settings > Cluster configuration > Authentication and Authorization > select `Microsoft Entra ID authentication with Azure RBAC` > Apply; then Azure portal > Kubernetes services > <cluster> > Access control (IAM) > Add > Add role assignment > `Azure Kubernetes Service RBAC Reader` / `Writer` / `Admin` > the Entra group > Review + assign
  - **CLI**:
    - Verify:
      ```bash
      az aks list \
        --query "[].{name:name, rg:resourceGroup, azureRbac:aadProfile.enableAzureRbac}" -o table
      ```
    - Expect: `azureRbac` = `True` on every cluster. Otherwise cluster permissions live only in in-cluster RoleBindings, invisible to Entra reviews and offboarding.
    - Fix: `az aks update -g <rg> -n <cluster> --enable-azure-rbac`
    - Fix:
      ```bash
      az role assignment create --assignee <group-object-id> \
        --role "Azure Kubernetes Service RBAC Reader" --scope <cluster-id>
      ```

- [ ] **Use Microsoft Entra ID Integration with Kubernetes RBAC** - pass: `aadProfile.managed` = `True` and `disableLocalAccounts` = `True`
  - **Console**:
    - Verify: Azure portal > Kubernetes services > <cluster> > Settings > Cluster configuration > `Authentication and Authorization` reads `Microsoft Entra ID authentication with Kubernetes RBAC` or `Microsoft Entra ID authentication with Azure RBAC`, and Azure portal > Kubernetes services > <cluster> > Overview > JSON View > `properties.disableLocalAccounts` reads `true`
    - Fix: Azure portal > Kubernetes services > <cluster> > Settings > Cluster configuration > Authentication and Authorization > select `Microsoft Entra ID authentication with Kubernetes RBAC` > Apply; then Azure portal > Cloud Shell (top bar) > run `az aks update -g <rg> -n <cluster> --disable-local-accounts`
  - **CLI**:
    - Verify:
      ```bash
      az aks list \
        --query "[].{name:name, rg:resourceGroup, managedAad:aadProfile.managed, localAccounts:disableLocalAccounts}" -o table
      ```
    - Expect: `managedAad` = `True` and `localAccounts` = `True` (local accounts disabled) on every cluster. A live `clusterAdmin` kubeconfig is a static credential that bypasses Entra entirely.
    - Fix: `az aks update -g <rg> -n <cluster> --enable-aad --disable-local-accounts`
    - Fix: `az aks get-credentials -g <rg> -n <cluster>`

- [ ] **Enable Support for Network Policies** - pass: `networkPolicy` is `azure`, `calico` or `cilium`
  - **Console**:
    - Verify: Azure portal > Kubernetes services > <cluster> > Settings > Networking > `Network policy` reads `Azure`, `Calico` or `Cilium`
    - Fix: Azure portal > Cloud Shell (top bar) > run `az aks update -g <rg> -n <cluster> --network-policy azure`; then apply a default-deny NetworkPolicy per namespace and allow-list the flows you need
  - **CLI**:
    - Verify:
      ```bash
      az aks list \
        --query "[].{name:name, rg:resourceGroup, networkPolicy:networkProfile.networkPolicy, plugin:networkProfile.networkPlugin}" -o table
      ```
    - Expect: `networkPolicy` is `azure`, `calico` or `cilium` on every cluster. A blank value means every pod can reach every other pod, so one compromised container reaches the whole cluster.
    - Fix: `az aks update -g <rg> -n <cluster> --network-policy azure`

- [ ] **Kubernetes Clusters with Private Nodes** - pass: `enableNodePublicIp` = `False` on every node pool
  - **Console**:
    - Verify: Azure portal > Kubernetes services > <cluster> > Overview > JSON View > every entry in `properties.agentPoolProfiles[]` has `enableNodePublicIP` = `false`
    - Fix: Azure portal > Kubernetes services > <cluster> > Settings > Node pools > Add node pool > Optional settings tab > leave `Enable public IP per node` unchecked > Add; then Azure portal > Kubernetes services > <cluster> > Settings > Node pools > select the old pool > Delete
  - **CLI**:
    - Verify:
      ```bash
      az aks list --query "[].{n:name, g:resourceGroup}" -o tsv | while read n g; do
        az aks nodepool list --cluster-name "$n" -g "$g" --query "[].{cluster:'$n', pool:name, publicIp:enableNodePublicIp}" -o tsv
      done
      ```
    - Expect: `publicIp` is `False` for every node pool. Nodes with public IPs expose the kubelet and any hostNetwork pod directly.
    - Fix: `az aks nodepool add -g <rg> --cluster-name <cluster> -n <new-pool> --node-count <n>`
    - Fix: `az aks nodepool delete -g <rg> --cluster-name <cluster> -n <old-pool>`

- [ ] **Private Kubernetes Clusters** - pass: `enablePrivateCluster` = `True` on production clusters
  - **Console**:
    - Verify: Azure portal > Kubernetes services > <cluster> > Settings > Networking > `Private cluster` reads Enabled on every production cluster
    - Fix: Azure portal > Kubernetes services > Create > Kubernetes cluster > Networking tab > check `Enable private cluster` > Review + create > Create, then migrate workloads and reach the API server over a VPN, ExpressRoute or a jump host in the same virtual network (a private cluster cannot be enabled after creation)
  - **CLI**:
    - Verify:
      ```bash
      az aks list \
        --query "[].{name:name, rg:resourceGroup, privateCluster:apiServerAccessProfile.enablePrivateCluster}" -o table
      ```
    - Expect: `privateCluster` = `True` for every production cluster, so the API server is reachable only over private networking. A public API server is a permanently exposed control plane.
    - Fix: `az aks create -g <rg> -n <new-cluster> --enable-private-cluster`

- [ ] **Secure Access to Kubernetes API Server Using Authorized IP Address Ranges** - pass: `authorizedIpRanges` non-empty and free of `0.0.0.0/0`
  - **Console**:
    - Verify: Azure portal > Kubernetes services > <cluster> > Settings > Networking > Security > `Set authorized IP ranges` is checked and the list is non-empty with no `0.0.0.0/0` on every cluster whose `Private cluster` reads Disabled
    - Fix: Azure portal > Kubernetes services > <cluster> > Settings > Networking > Security > check `Set authorized IP ranges` > enter your office, VPN and CI egress CIDRs > Apply
  - **CLI**:
    - Verify:
      ```bash
      az aks list \
        --query "[].{name:name, rg:resourceGroup, privateCluster:apiServerAccessProfile.enablePrivateCluster, allowedRanges:apiServerAccessProfile.authorizedIpRanges}" -o table
      ```
    - Expect: every cluster with `privateCluster` = `False` has a non-empty `allowedRanges` that contains no `0.0.0.0/0`. An empty list means the API server accepts connections from the entire internet.
    - Fix:
      ```bash
      az aks update -g <rg> -n <cluster> \
        --api-server-authorized-ip-ranges <office-cidr>,<vpn-cidr>,<ci-egress-ip>/32
      ```

- [ ] **Use Private Key Vaults for Encryption at Rest in Azure Kubernetes Service** - pass: `azureKeyVaultKms.enabled` = `True` with `keyVaultNetworkAccess` = `Private`
  - **Console**:
    - Verify: Azure portal > Kubernetes services > <cluster> > Overview > JSON View > `properties.securityProfile.azureKeyVaultKms.enabled` reads `true`, `properties.securityProfile.azureKeyVaultKms.keyVaultNetworkAccess` reads `Private`, and `properties.diskEncryptionSetID` points at a customer-managed key
    - Fix: Azure portal > Cloud Shell (top bar) > run `az aks update -g <rg> -n <cluster> --enable-azure-keyvault-kms --azure-keyvault-kms-key-vault-network-access Private --azure-keyvault-kms-key-vault-resource-id <vault-id> --azure-keyvault-kms-key-id <key-uri>`
  - **CLI**:
    - Verify:
      ```bash
      az aks list \
        --query "[].{name:name, rg:resourceGroup, kms:securityProfile.azureKeyVaultKms.enabled, kvAccess:securityProfile.azureKeyVaultKms.keyVaultNetworkAccess, diskEncryptionSet:diskEncryptionSetId}" -o table
      ```
    - Expect: `kms` = `True` with `kvAccess` = `Private`, and `diskEncryptionSet` pointing at a customer-managed key, on every cluster. Otherwise etcd secrets are protected only by platform-managed keys you cannot rotate or revoke.
    - Fix:
      ```bash
      az aks update -g <rg> -n <cluster> --enable-azure-keyvault-kms \
        --azure-keyvault-kms-key-vault-network-access Private \
        --azure-keyvault-kms-key-vault-resource-id <vault-id> \
        --azure-keyvault-kms-key-id <key-uri>
      ```

---

## Monitoring & Activity Logs

- [ ] **Activity Log All Activities** - pass: all eight log categories enabled
  - **Console**:
    - Verify: Azure portal > Monitor > Activity log > Export Activity Logs > select the subscription > Edit setting on each diagnostic setting > all eight categories are checked: `Administrative`, `Security`, `ServiceHealth`, `Alert`, `Recommendation`, `Policy`, `Autoscale`, `ResourceHealth`
    - Fix: Azure portal > Monitor > Activity log > Export Activity Logs > select the subscription > Edit setting > check every category under Logs > Save
  - **CLI**:
    - Verify:
      ```bash
      az monitor diagnostic-settings subscription list \
        --query "value[].{name:name, categories:logs[?enabled].category}" -o json
      ```
    - Expect: `categories` includes all eight: `Administrative`, `Security`, `ServiceHealth`, `Alert`, `Recommendation`, `Policy`, `Autoscale`, `ResourceHealth`. A missing `Administrative` or `Policy` category hides exactly the events an attacker generates.
    - Fix:
      ```bash
      az monitor diagnostic-settings subscription create --name <existing-setting-name> --location <region> \
        --workspace <workspace-resource-id> \
        --logs '[{"category":"Administrative","enabled":true},{"category":"Security","enabled":true},
                 {"category":"ServiceHealth","enabled":true},{"category":"Alert","enabled":true},
                 {"category":"Recommendation","enabled":true},{"category":"Policy","enabled":true},
                 {"category":"Autoscale","enabled":true},{"category":"ResourceHealth","enabled":true}]'
      ```

- [ ] **Check for Publicly Accessible Activity Log Storage Container** - pass: `allowBlobPublicAccess` = `false` and no container with public access
  - **Console**:
    - Verify: Azure portal > Storage accounts > <activity-log-account> > Settings > Configuration > `Allow Blob anonymous access` reads Disabled; and Azure portal > Storage accounts > <activity-log-account> > Data storage > Containers > the `Anonymous access level` column reads Private for every container
    - Fix: Azure portal > Storage accounts > <activity-log-account> > Settings > Configuration > Allow Blob anonymous access > Disabled > Save; then Azure portal > Storage accounts > <activity-log-account> > Data storage > Containers > select `insights-activity-logs` > Change access level > `Private (no anonymous access)` > OK
  - **CLI**:
    - Verify: `az monitor diagnostic-settings subscription list --query "value[].storageAccountId" -o tsv`
    - Verify:
      ```bash
      az storage account show --ids <storage-account-id> \
        --query "{name:name, publicBlobAccess:allowBlobPublicAccess, publicNetwork:publicNetworkAccess}"
      ```
    - Verify:
      ```bash
      az storage container list --account-name <storage-account> --auth-mode login \
        --query "[?properties.publicAccess!=null].{name:name, access:properties.publicAccess}" -o table
      ```
    - Expect: `publicBlobAccess` = `false` for every account the first command returns, and the container query returns no rows. The `insights-activity-logs` container holds a record of every control-plane action, so anonymous read access hands an attacker your entire tenant map.
    - Fix: `az storage account update --ids <storage-account-id> --allow-blob-public-access false`
    - Fix:
      ```bash
      az storage container set-permission --name insights-activity-logs --account-name <storage-account> \
        --public-access off --auth-mode login
      ```

- [ ] **Enable Subscription Activity Log Diagnostic Settings** - pass: at least one setting exporting outside the audited subscription
  - **Console**:
    - Verify: Azure portal > Monitor > Activity log > Export Activity Logs > select the subscription > at least one diagnostic setting is listed whose Log Analytics workspace or storage account destination lives in a different subscription
    - Fix: Azure portal > Monitor > Activity log > Export Activity Logs > select the subscription > Add diagnostic setting > name it > check every category under Logs > Send to Log Analytics workspace > pick a workspace in a separate logging subscription > Save
  - **CLI**:
    - Verify:
      ```bash
      az monitor diagnostic-settings subscription list \
        --query "value[].{name:name, workspace:workspaceId, storage:storageAccountId, eventHub:eventHubAuthorizationRuleId}" -o table
      ```
    - Expect: at least one setting exists and its `workspace` or `storage` destination lives outside the subscription being audited. No setting means the activity log ages out after 90 days and an attacker's tracks expire on their own.
    - Fix:
      ```bash
      az monitor diagnostic-settings subscription create --name activity-log-export --location <region> \
        --workspace <workspace-resource-id> \
        --logs '[{"category":"Administrative","enabled":true},{"category":"Security","enabled":true},
                 {"category":"ServiceHealth","enabled":true},{"category":"Alert","enabled":true},
                 {"category":"Recommendation","enabled":true},{"category":"Policy","enabled":true},
                 {"category":"Autoscale","enabled":true},{"category":"ResourceHealth","enabled":true}]'
      ```

---

## App Service

- [ ] **Enable HTTPS-Only Traffic** - pass: `httpsOnly` = `True` and `minTlsVersion` 1.2 or higher
  - **Console**:
    - Verify: Azure portal > App Services > <app> > Settings > Configuration > General settings tab > Platform settings > `HTTPS Only` reads On and `Minimum Inbound TLS Version` reads 1.2 or higher
    - Fix: Azure portal > App Services > <app> > Settings > Configuration > General settings tab > Platform settings > HTTPS Only > On > Minimum Inbound TLS Version > 1.2 > Save > Continue
  - **CLI**:
    - Verify: `az webapp list --query "[].{name:name, rg:resourceGroup, httpsOnly:httpsOnly}" -o table`
    - Verify: `az webapp config show -g <rg> -n <app> --query minTlsVersion -o tsv`
    - Expect: `httpsOnly` = `True` on every app and `minTlsVersion` returns `1.2` or higher for each. Plain HTTP or old TLS lets a network attacker read or rewrite session tokens in transit.
    - Fix: `az webapp update -g <rg> -n <app> --set httpsOnly=true`
    - Fix: `az webapp config set -g <rg> -n <app> --min-tls-version 1.2`

- [ ] **Disable Plain FTP Deployment** - pass: `ftpsState` = `Disabled` on every app
  - **Console**:
    - Verify: Azure portal > App Services > <app> > Settings > Configuration > General settings tab > Platform settings > `FTP state` reads Disabled
    - Fix: Azure portal > App Services > <app> > Settings > Configuration > General settings tab > Platform settings > FTP state > Disabled > Save > Continue; deploy through Azure portal > App Services > <app> > Deployment > Deployment Center (GitHub Actions with OIDC) instead
  - **CLI**:
    - Verify:
      ```bash
      az webapp list --query "[].{n:name, g:resourceGroup}" -o tsv | while read n g; do
        echo "$n: $(az webapp config show -g "$g" -n "$n" --query ftpsState -o tsv)"
      done
      ```
    - Expect: every app reports `Disabled` (`FtpsOnly` is the minimum acceptable fallback if a legacy pipeline still needs it). `AllAllowed` sends deployment credentials over plaintext FTP.
    - Fix: `az webapp config set -g <rg> -n <app> --ftps-state Disabled`

- [ ] **Disable Remote Debugging** - pass: `remoteDebuggingEnabled` = `false` on every app
  - **Console**:
    - Verify: Azure portal > App Services > <app> > Settings > Configuration > General settings tab > Debugging > `Remote debugging` reads Off
    - Fix: Azure portal > App Services > <app> > Settings > Configuration > General settings tab > Debugging > Remote debugging > Off > Save > Continue
  - **CLI**:
    - Verify:
      ```bash
      az webapp list --query "[].{n:name, g:resourceGroup}" -o tsv | while read n g; do
        echo "$n: $(az webapp config show -g "$g" -n "$n" --query remoteDebuggingEnabled -o tsv)"
      done
      ```
    - Expect: every app reports `false`. Remote debugging attaches a debugger to production and is frequently left on after an incident.
    - Fix: `az webapp config set -g <rg> -n <app> --remote-debugging-enabled false`

- [ ] **Enable App Service Authentication** - pass: `platform.enabled` = `true` on every non-public app
  - **Console**:
    - Verify: Azure portal > App Services > <app> > Settings > Authentication > Authentication settings > `App Service authentication` reads Enabled and `Restrict access` reads `Require authentication` on every app that is not intentionally public
    - Fix: Azure portal > App Services > <app> > Settings > Authentication > Add identity provider > Identity provider > Microsoft > Restrict access > Require authentication > Unauthenticated requests > `HTTP 302 Found redirect: recommended for websites` > Add
  - **CLI**:
    - Verify:
      ```bash
      az webapp list --query "[].{n:name, g:resourceGroup}" -o tsv | while read n g; do
        echo "$n: $(az webapp auth show -g "$g" -n "$n" --query "platform.enabled" -o tsv)"
      done
      ```
    - Expect: `true` for every app that is not intentionally public. This is the platform-level gate that runs before your own code, so it still holds if an application-layer auth check regresses.
    - Fix:
      ```bash
      az webapp auth update -g <rg> -n <app> --enabled true \
        --action LoginWithAzureActiveDirectory --unauthenticated-client-action RedirectToLoginPage
      ```

- [ ] **Use Key Vaults to Store App Service Application Secrets** - pass: no secret-shaped setting holds a literal value
  - **Console**:
    - Verify: Azure portal > App Services > <app> > Settings > Environment variables > App settings tab > every setting whose name suggests a secret (`*KEY*`, `*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*CONNECTIONSTRING*`, `*PRIVATE*`) shows `Key vault Reference` in the Source column
    - Fix: Azure portal > Key vaults > <vault> > Objects > Secrets > Generate/Import > store the value > Create; then Azure portal > App Services > <app> > Settings > Identity > System assigned > On > Save; then Azure portal > Key vaults > <vault> > Access control (IAM) > Add > Add role assignment > `Key Vault Secrets User` > the app's managed identity > Review + assign; then Azure portal > App Services > <app> > Settings > Environment variables > App settings tab > select the setting > Value > `@Microsoft.KeyVault(SecretUri=<secret-uri>)` > Apply > Apply; then rotate every secret that was previously stored in plaintext
  - **CLI**:
    - Verify:
      ```bash
      az webapp list --query "[].{n:name, g:resourceGroup}" -o tsv | while read n g; do
        echo "== $n"
        az webapp config appsettings list -g "$g" -n "$n" --query "[?!starts_with(value, '@Microsoft.KeyVault')].name" -o tsv
      done
      ```
    - Expect: no setting whose name suggests a secret (`*KEY*`, `*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*CONNECTIONSTRING*`, `*PRIVATE*`) appears in the output. Anything listed is a literal value readable by everyone with Contributor on the app, and it shows up in exports and ARM templates.
    - Fix:
      ```bash
      az keyvault secret set --vault-name <vault> --name <secret> --value <value>
      az webapp identity assign -g <rg> -n <app>
      az role assignment create --assignee "$(az webapp identity show -g <rg> -n <app> --query principalId -o tsv)" \
        --role "Key Vault Secrets User" --scope "$(az keyvault show --name <vault> --query id -o tsv)"
      az webapp config appsettings set -g <rg> -n <app> \
        --settings <NAME>="@Microsoft.KeyVault(SecretUri=<secret-uri>)"
      ```
