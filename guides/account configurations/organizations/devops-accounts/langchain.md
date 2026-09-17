<!--
id: langchain-organization-configuration
type: CONFIGURATION
scope: ORGANIZATION
-->

<div align="center">
  <img src="../../../../images/guides/langchain.svg" alt="LangChain Logo" width="64" height="64">
  <h2><a href="https://www.langchain.com/" target="_blank" rel="noopener noreferrer">LangChain</a> Configuration Guide</h2>
  <p><em>Supply-chain, Agent Server, Tracing, MCP and Workload-Isolation controls for LangChain and LangGraph deployments</em></p>
</div>

---

## How to Use This Guide

Each item states its **pass** condition, then gives **CLI** steps (`pip`, `npm`, `jq`, `kubectl` and code changes in the agent repository) to **Verify** and **Fix** it, and **Console** (the LangSmith web UI) steps where the setting is visible there. Under CLI, **Expect** is the output that means it passes. LangChain is a library and the Agent Server is configured through `langgraph.json`, so most items have no console channel; an item shows only the channels that can check or change the setting, and it passes only when every repository, image and deployment the command returns meets the condition.

#### Prerequisites

- Run the repository checks from the root of each agent repository, in the virtual environment the agent ships with. `langgraph.json` lives in that root.
- `jq` for editing `langgraph.json`. Every `jq` fix writes to a temp file and moves it into place; commit the result.
- Kubernetes items assume the Agent Server runs as one deployment in one namespace: `export NS=<namespace> AGENT=<agent-server>`
- `kubectl set env` and `kubectl patch` change the live deployment. Write the same change into the manifests or Helm values so the next rollout keeps it.
- Repeat the whole guide for every agent repository and every environment.

---

## SDK & Supply Chain

- [ ] **Upgrade Every LangChain Package to a Patched Release** - pass: `pip-audit` reports no known vulnerabilities in the installed LangChain packages
  - **CLI**:
    - Verify: `pip-audit -r requirements.txt`
    - Expect: `No known vulnerabilities found`. Every advisory listed is a public exploit path into the agent process.
    - Fix: `pip install pip-audit && pip-audit -r requirements.txt --fix && pip install -r requirements.txt`
- [ ] **Pin and Patch the Checkpoint and Store Packages Separately** - pass: `langgraph-checkpoint` and its Postgres and SQLite backends are pinned to their current patched releases
  - **CLI**:
    - Verify: `pip show langgraph-checkpoint langgraph-checkpoint-postgres langgraph-checkpoint-sqlite`
    - Expect: each package prints a `Version` equal to the latest release on PyPI. The checkpoint packages deserialize stored state, so an old one is a deserialization bug waiting for a crafted checkpoint.
    - Fix:
      ```bash
      pip install pip-tools && pip-compile -P langgraph-checkpoint -P langgraph-checkpoint-postgres \
        -P langgraph-checkpoint-sqlite -o requirements.txt requirements.in && pip install -r requirements.txt
      ```
- [ ] **Rebuild the Agent Server Image on a Patched Release** - pass: the deployed agent image carries the latest `langgraph-api` release
  - **CLI**:
    - Verify: `docker run --rm <agent-image>:<tag> pip show langgraph-api`
    - Expect: `Version` equals the latest `langgraph-api` release. The server package is the HTTP surface of the agent, and an old image keeps every fixed server bug live.
    - Fix: `langgraph build --pull -t <agent-image>:<tag>`
- [ ] **Upgrade the Tracing SDK to a Patched Release** - pass: `langsmith` is at its latest release
  - **CLI**:
    - Verify: `pip show langsmith`
    - Expect: `Version` equals the latest `langsmith` release. The tracing SDK ships prompts and outputs off the host, so a patched client is the one you want handling them.
    - Fix: `pip install -U langsmith`
- [ ] **Require Package Hashes on Every Install** - pass: `requirements.txt` carries `--hash=` for every package and the image installs with `--require-hashes`
  - **CLI**:
    - Verify: `grep -nE "require-hashes|--hash=" requirements*.txt Dockerfile`
    - Expect: a `--hash=` line for every requirement and `--require-hashes` in the install command. Without hashes a hijacked package name on the index installs unnoticed.
    - Fix:
      ```bash
      pip install pip-tools && pip-compile --generate-hashes -o requirements.txt requirements.in && \
        pip install --require-hashes -r requirements.txt
      ```
- [ ] **Pin langchain-community to Its Final Release and Schedule Its Removal (archived by the vendor, no further security fixes; move each integration to its partner package)** - pass: `langchain-community` is pinned to its final release and a dated ticket tracks moving each integration to its partner package
  - **CLI**:
    - Verify: `pip show langchain-community`
    - Expect: either `not found`, or `Version` equal to the final published release with a removal ticket on the board. An archived package ships no fix for the next advisory.
    - Fix:
      ```bash
      pip install pip-tools && pip-compile -P langchain-community -o requirements.txt requirements.in && \
        pip install -r requirements.txt
      ```
- [ ] **Uninstall langchain-experimental (archived by the vendor, no further fixes; it ships the in-process PythonREPLTool and PALChain)** - pass: `langchain-experimental` is not installed and not listed in any requirements file
  - **CLI**:
    - Verify: `pip show langchain-experimental`
    - Expect: `WARNING: Package(s) not found: langchain-experimental`. The package puts an unsandboxed Python REPL one import away from every agent.
    - Fix: `pip uninstall -y langchain-experimental && sed -i '/^langchain-experimental/d' requirements.in requirements.txt`
- [ ] **Upgrade the JavaScript Packages to Patched Releases** - pass: `npm audit` reports no vulnerabilities in the LangChain JavaScript packages
  - **CLI**:
    - Verify: `npm audit`
    - Expect: `found 0 vulnerabilities`. Each listed advisory is a public exploit path into the Node agent.
    - Fix: `npm audit fix`
- [ ] **Make the Advisory Scan Fail the Build** - pass: the CI pipeline runs `pip-audit` and `npm audit --audit-level=high` as blocking steps
  - **CLI**:
    - Verify: `grep -rnE "pip-audit|npm audit" .github .gitlab-ci.yml Jenkinsfile 2>/dev/null`
    - Expect: at least one hit in a pipeline step that has no `continue-on-error` or `allow_failure`. A scan that only warns is a scan nobody reads.
    - Fix: `pip install pip-audit && pip-audit -r requirements.txt && npm audit --audit-level=high`

---

## Agent Security (Tools & Code Execution)

- [ ] **Set Every allow_dangerous_ Opt-In to False (each opt-in lets the agent load pickled objects or fetch arbitrary URLs)** - pass: no `allow_dangerous_*=True` remains in the repository
  - **CLI**:
    - Verify: `grep -rn "allow_dangerous_" --include="*.py" .`
    - Expect: no output, or only lines ending in `=False`. Each opt-in lets the agent unpickle attacker-supplied objects or fetch arbitrary URLs from inside the server.
    - Fix:
      ```bash
      sed -i -E 's/(allow_dangerous_[a-z_]+)=True/\1=False/g' \
        $(grep -rlE "allow_dangerous_[a-z_]+=True" --include="*.py" .)
      ```
- [ ] **Replace In-Process Code Execution with a Container-Sandboxed Shell Tool (PythonREPLTool, PALChain and ShellTool run agent-written code inside the server process; the default host policy sandboxes nothing)** - pass: no in-process code tool is imported and every shell tool uses a container execution policy
  - **CLI**:
    - Verify: `grep -rnE "PythonREPL|PALChain|langchain_community.tools.shell|HostExecutionPolicy" --include="*.py" .`
    - Expect: no output. An in-process tool runs model-written code with the server's secrets, filesystem and network.
    - Fix:
      ```python
      from langchain.agents.middleware import ShellToolMiddleware, DockerExecutionPolicy

      ShellToolMiddleware(execution_policy=DockerExecutionPolicy(image="<sandbox-image>"))
      ```
- [ ] **Grant Tool Credentials Read-Only Access Wherever the Task Allows** - pass: every database credential a tool holds can only `SELECT` unless the task needs writes
  - **CLI**:
    - Verify: `psql -d <db> -c "SELECT has_table_privilege('agent_ro', '<table>', 'INSERT, UPDATE, DELETE')"`
    - Expect: `f`. A tool credential that can write turns a prompt injection into a data-destruction path.
    - Fix:
      ```bash
      psql -d <db> -c "CREATE ROLE agent_ro LOGIN PASSWORD '<password>'; GRANT CONNECT ON DATABASE <db> TO agent_ro; \
        GRANT USAGE ON SCHEMA public TO agent_ro; GRANT SELECT ON ALL TABLES IN SCHEMA public TO agent_ro"
      ```
- [ ] **Require Human Approval Before an Irreversible Tool Runs** - pass: every tool that sends, deletes, pays or deploys is listed in a `HumanInTheLoopMiddleware` `interrupt_on` map
  - **CLI**:
    - Verify: `grep -rn "interrupt_on" --include="*.py" .`
    - Expect: one `interrupt_on` entry naming each irreversible tool. Without an interrupt the model's first mistaken call is final.
    - Fix: `HumanInTheLoopMiddleware(interrupt_on={"<send_or_delete_tool>": True})`
- [ ] **Set Tool and Model Call Limits** - pass: every agent runs with `ToolCallLimitMiddleware` and `ModelCallLimitMiddleware` and explicit run limits
  - **CLI**:
    - Verify: `grep -rnE "ToolCallLimitMiddleware|ModelCallLimitMiddleware" --include="*.py" .`
    - Expect: both middlewares appear in every agent definition with a `run_limit`. An unbounded loop burns budget and keeps retrying a harmful tool call until it succeeds.
    - Fix: `ToolCallLimitMiddleware(run_limit=<n>), ModelCallLimitMiddleware(run_limit=<n>)`
- [ ] **Review Every Public Prompt-Hub Pull and Replace It with a Prompt You Own** - pass: no agent pulls a public hub prompt at runtime; every prompt lives in a workspace you own
  - **Console**:
    - Verify: LangSmith > Prompts > every prompt the agents load is listed under your workspace, and none is a public prompt from another owner
    - Fix: LangSmith > Prompts > open the public prompt > Fork into your workspace > review the text > Commit; then update the agent to pull your copy by name
  - **CLI**:
    - Verify: `grep -rnE "dangerously_pull_public_prompt|pull_prompt|hub.pull|pullPrompt" .`
    - Expect: no `dangerously_pull_public_prompt`, and every `pull_prompt` names a prompt in your own workspace. A public prompt can be edited by its owner at any time and lands in your agent on the next run.
    - Fix: `Client().push_prompt("<prompt-name>", object=<prompt>)`

---

## Agent Server (Authentication & Exposed Surface)

- [ ] **Configure Custom Authentication** - pass: `auth.path` in `langgraph.json` points at your authentication handler
  - **CLI**:
    - Verify: `jq '.auth.path' langgraph.json`
    - Expect: `"./auth.py:auth"` or your handler's path, not `null`. Without a handler every request to the server is anonymous.
    - Fix: `jq '.auth.path = "./auth.py:auth"' langgraph.json > langgraph.json.tmp && mv langgraph.json.tmp langgraph.json`
- [ ] **Do Not Turn Off Authentication for Studio Requests** - pass: `auth.disable_studio_auth` is `false` or absent
  - **CLI**:
    - Verify: `jq '.auth.disable_studio_auth' langgraph.json`
    - Expect: `false` or `null`. Disabling it lets any request that claims to come from Studio skip your handler.
    - Fix:
      ```bash
      jq '.auth.disable_studio_auth = false' langgraph.json > langgraph.json.tmp && mv langgraph.json.tmp langgraph.json
      ```
- [ ] **Restrict CORS Origins to an Explicit List** - pass: `http.cors.allow_origins` lists only your application origins
  - **CLI**:
    - Verify: `jq '.http.cors.allow_origins' langgraph.json`
    - Expect: an array of your own `https://` origins with no `*`. A wildcard lets any web page call the server with the user's cookies.
    - Fix:
      ```bash
      jq '.http.cors.allow_origins = ["https://<app-origin>"]' langgraph.json > langgraph.json.tmp && \
        mv langgraph.json.tmp langgraph.json
      ```
- [ ] **Disable Unused Endpoints** - pass: every endpoint group the agent does not use (`mcp`, `a2a`, `ui`, `meta`, `store`) is disabled
  - **CLI**:
    - Verify: `jq '.http | {disable_mcp, disable_a2a, disable_ui, disable_meta, disable_store}' langgraph.json`
    - Expect: `true` for every group the agent does not use. Each enabled group is an authenticated surface you are not watching.
    - Fix:
      ```bash
      jq '.http += {disable_mcp:true, disable_a2a:true, disable_ui:true, disable_meta:true, disable_store:true}' \
        langgraph.json > langgraph.json.tmp && mv langgraph.json.tmp langgraph.json
      ```
- [ ] **Enable Authentication on Custom Routes and Run It First** - pass: `http.enable_custom_route_auth` is `true` and `http.middleware_order` is `auth_first`
  - **CLI**:
    - Verify: `jq '.http.enable_custom_route_auth, .http.middleware_order' langgraph.json`
    - Expect: `true` then `"auth_first"`. Otherwise custom routes serve unauthenticated, and custom middleware runs before the caller is known.
    - Fix:
      ```bash
      jq '.http.enable_custom_route_auth = true | .http.middleware_order = "auth_first"' langgraph.json \
        > langgraph.json.tmp && mv langgraph.json.tmp langgraph.json
      ```
- [ ] **Exclude Credentials from Header Logging** - pass: `http.logging_headers.excludes` lists `authorization`, `cookie` and `x-api-key`
  - **CLI**:
    - Verify: `jq '.http.logging_headers' langgraph.json`
    - Expect: an `excludes` array containing `authorization`, `cookie` and `x-api-key`. Logged headers put every bearer token and session cookie into the log pipeline.
    - Fix:
      ```bash
      jq '.http.logging_headers = {excludes: ["authorization", "cookie", "x-api-key"]}' langgraph.json \
        > langgraph.json.tmp && mv langgraph.json.tmp langgraph.json
      ```
- [ ] **Do Not Enable the LangSmith API-Key Fallback** - pass: `auth.allow_langsmith_api_keys` is `false` or absent
  - **CLI**:
    - Verify: `jq '.auth.allow_langsmith_api_keys' langgraph.json`
    - Expect: `false` or `null`. With the fallback on, any LangSmith API key in the workspace also authenticates to the agent, bypassing your handler.
    - Fix:
      ```bash
      jq '.auth.allow_langsmith_api_keys = false' langgraph.json > langgraph.json.tmp && mv langgraph.json.tmp langgraph.json
      ```

---

## Agent Server (State, Webhooks & Encryption)

- [ ] **Set Checkpoint and Store TTLs** - pass: `checkpointer.ttl` and `store.ttl` set a `default_ttl` no longer than your retention policy
  - **CLI**:
    - Verify: `jq '.checkpointer.ttl, .store.ttl' langgraph.json`
    - Expect: both objects present with `default_ttl` in minutes within policy and a `sweep_interval_minutes`. Without a TTL every conversation and its inputs stay in the database forever.
    - Fix:
      ```bash
      jq '.checkpointer.ttl = {strategy:"delete", default_ttl:43200, sweep_interval_minutes:60} |
          .store.ttl = {default_ttl:43200, refresh_on_read:false, sweep_interval_minutes:60}' \
        langgraph.json > langgraph.json.tmp && mv langgraph.json.tmp langgraph.json
      ```
- [ ] **Disable the Pickle Fallback and Set an Explicit JSON Module Allowlist** - pass: `checkpointer.serde.pickle_fallback` is `false` and `allowed_json_modules` lists only the classes the state needs
  - **CLI**:
    - Verify: `jq '.checkpointer.serde' langgraph.json`
    - Expect: `pickle_fallback: false` and an explicit `allowed_json_modules` array. With pickle enabled a crafted checkpoint executes code when it is loaded.
    - Fix:
      ```bash
      jq '.checkpointer.serde = {pickle_fallback:false, allowed_json_modules:[["<module>","<Class>"]]}' \
        langgraph.json > langgraph.json.tmp && mv langgraph.json.tmp langgraph.json
      ```
- [ ] **Restrict Webhook Targets in the URL Policy** - pass: `webhooks.url` allows only your domains over HTTPS on port 443 and blocks private IPs
  - **CLI**:
    - Verify: `jq '.webhooks.url' langgraph.json`
    - Expect: `allowed_domains` naming your hosts, `require_https: true`, `disable_private_ips: true`, `allowed_ports: [443]`. An open policy lets a run's webhook field point at internal services.
    - Fix:
      ```bash
      jq '.webhooks.url = {allowed_domains:["hooks.<your-domain>"], require_https:true, disable_private_ips:true, allowed_ports:[443]}' \
        langgraph.json > langgraph.json.tmp && mv langgraph.json.tmp langgraph.json
      ```
- [ ] **Encrypt Checkpoints at Rest** - pass: `LANGGRAPH_AES_KEY` is set on the Agent Server from a secret and is 32 hex characters
  - **CLI**:
    - Verify: `kubectl exec deployment/$AGENT -n $NS -- printenv LANGGRAPH_AES_KEY | tr -d '\n' | wc -c`
    - Expect: `32`. Without the key every checkpoint sits in Postgres in plain text.
    - Fix:
      ```bash
      kubectl create secret generic langgraph-aes -n $NS --from-literal=LANGGRAPH_AES_KEY=$(openssl rand -hex 16) && \
        kubectl set env deployment/$AGENT -n $NS --from=secret/langgraph-aes
      ```

---

## Tracing & Data Protection

- [ ] **Disable Tracing or Point It at an Instance You Govern** - pass: `LANGSMITH_TRACING` is `false`, or `LANGSMITH_ENDPOINT` is a LangSmith instance you operate or contractually govern
  - **CLI**:
    - Verify: `kubectl exec deployment/$AGENT -n $NS -- printenv LANGSMITH_TRACING LANGSMITH_ENDPOINT`
    - Expect: `false`, or `true` followed by the endpoint of your governed instance. Default tracing sends every prompt and output to the vendor's cloud.
    - Fix: `kubectl set env deployment/$AGENT -n $NS LANGSMITH_TRACING=false`
- [ ] **Hide Inputs and Outputs When Traces Leave the Boundary** - pass: `LANGSMITH_HIDE_INPUTS` and `LANGSMITH_HIDE_OUTPUTS` are `true` whenever traces go to an external instance
  - **CLI**:
    - Verify: `kubectl exec deployment/$AGENT -n $NS -- printenv LANGSMITH_HIDE_INPUTS LANGSMITH_HIDE_OUTPUTS`
    - Expect: `true` on both lines. Otherwise the full prompt and completion, with whatever customer data they carry, leave the boundary in every trace.
    - Fix: `kubectl set env deployment/$AGENT -n $NS LANGSMITH_HIDE_INPUTS=true LANGSMITH_HIDE_OUTPUTS=true`
- [ ] **Set a Trace Sampling Rate** - pass: `LANGSMITH_TRACING_SAMPLING_RATE` is set below `1` in production
  - **CLI**:
    - Verify: `kubectl exec deployment/$AGENT -n $NS -- printenv LANGSMITH_TRACING_SAMPLING_RATE`
    - Expect: a value such as `0.1`. Full sampling exports every production conversation rather than a debugging sample.
    - Fix: `kubectl set env deployment/$AGENT -n $NS LANGSMITH_TRACING_SAMPLING_RATE=0.1`
- [ ] **Restrict Standalone-Server Egress to an Allowlist** - pass: the agent's egress NetworkPolicy allows the trace endpoint on 443 and nothing else beyond the model and checkpoint endpoints
  - **CLI**:
    - Verify: `kubectl get networkpolicy -n $NS`
    - Expect: an egress policy selecting the agent pods, with rules only for the model, checkpoint and trace endpoints. Unrestricted egress lets a prompt injection exfiltrate state to any host.
    - Fix:
      ```bash
      kubectl patch networkpolicy <agent-egress-policy> -n $NS --type json -p \
        '[{"op":"add","path":"/spec/egress/-","value":{"to":[{"ipBlock":{"cidr":"<trace-endpoint-cidr>"}}],"ports":[{"protocol":"TCP","port":443}]}}]'
      ```

---

## MCP Servers & Tool Connections

- [ ] **Connect to MCP Servers Over HTTPS Only, with an Explicit Credential** - pass: every MCP client URL is `https://` and carries an explicit auth credential
  - **CLI**:
    - Verify: `grep -rn "http://" --include="*.py" .`
    - Expect: no MCP server URL in the output. A plain-HTTP MCP connection exposes tool calls and their credentials on the wire.
    - Fix: `MCPAdapter(Client("https://<mcp-server>/mcp", auth=<token>))`
- [ ] **Require Approval for MCP Tools Annotated Destructive, Not by Tool Name** - pass: the interrupt policy keys on the MCP `destructiveHint` annotation rather than a list of tool names
  - **CLI**:
    - Verify: `grep -rnE "destructive_?[Hh]int" --include="*.py" .`
    - Expect: at least one hit inside the approval predicate. A name list misses every destructive tool the MCP server adds or renames later.
    - Fix: `InterruptOnConfig(allowed_decisions=["approve", "reject"], when=needs_approval)`
- [ ] **Send Each User's Own Credential on MCP Calls, Never One Shared Token** - pass: MCP calls carry the requesting user's token, and no shared static token is configured
  - **CLI**:
    - Verify: `grep -rnwE "auth|headers" --include="*.py" .`
    - Expect: every MCP client auth derives from the current user, with no hard-coded or environment-wide token. A shared token gives every user the union of everyone's permissions on the MCP server.
    - Fix: `MCPAdapter(Client(CONFIG, auth=BearerAuth(token_for(user))))`

---

## Workload Isolation (Kubernetes)

- [ ] **Deny All Egress by Default and Allow Only the Model, Checkpoint and Trace Endpoints** - pass: a NetworkPolicy selecting the agent pods denies egress by default and allows only the model, checkpoint and trace endpoints
  - **CLI**:
    - Verify: `kubectl get networkpolicy -n $NS -o yaml`
    - Expect: a policy with `policyTypes: [Egress]` selecting the agent pods and `egress` rules only for the three endpoint sets. Without it the agent can reach every service in the cluster and on the internet.
    - Fix: `kubectl apply -n $NS -f <agent-egress-networkpolicy>.yaml`
- [ ] **Block the Metadata Endpoint** - pass: the egress policy excludes `169.254.169.254/32`
  - **CLI**:
    - Verify: `kubectl get networkpolicy -n $NS -o yaml | grep 169.254.169.254`
    - Expect: the address appears under an `except` list. Reaching the metadata endpoint hands the agent the node's cloud credentials.
    - Fix:
      ```bash
      kubectl patch networkpolicy <agent-egress-policy> -n $NS --type json -p \
        '[{"op":"add","path":"/spec/egress/0/to/0/ipBlock/except","value":["169.254.169.254/32"]}]'
      ```
- [ ] **Disable Service-Account Token Automount** - pass: the agent's service account has `automountServiceAccountToken: false`
  - **CLI**:
    - Verify: `kubectl get sa -n $NS -o jsonpath='{.items[*].automountServiceAccountToken}'`
    - Expect: `false` for the agent's service account. A mounted token lets code the agent runs talk to the Kubernetes API as the pod.
    - Fix: `kubectl patch serviceaccount <agent-sa> -n $NS -p '{"automountServiceAccountToken": false}'`
- [ ] **Run the Agent Non-Root with a Read-Only Root Filesystem** - pass: the agent pod has `runAsNonRoot: true`, `readOnlyRootFilesystem: true` and `allowPrivilegeEscalation: false`
  - **CLI**:
    - Verify: `kubectl get pod -n $NS -o jsonpath='{.items[*].spec.containers[*].securityContext}'`
    - Expect: `readOnlyRootFilesystem:true` and `allowPrivilegeEscalation:false` on every agent container, with `runAsNonRoot:true` on the pod. A root, writable container turns any code-execution bug into a full host foothold.
    - Fix:
      ```bash
      kubectl patch deployment $AGENT -n $NS --type json -p \
        '[{"op":"add","path":"/spec/template/spec/securityContext","value":{"runAsNonRoot":true}},
          {"op":"add","path":"/spec/template/spec/containers/0/securityContext","value":{"readOnlyRootFilesystem":true,"allowPrivilegeEscalation":false}}]'
      ```
- [ ] **Move Any Provider Key Found in the Repository or Image to a Secret Manager and Rotate It** - pass: no provider or LangSmith key appears in the repository or image, and every key found was rotated
  - **CLI**:
    - Verify: `grep -rnE "(sk-|lsv2_)[A-Za-z0-9_-]{20,}" --exclude-dir=.git .`
    - Expect: no output. A key in git history or an image layer is already shared with everyone who can pull either.
    - Fix:
      ```bash
      kubectl create secret generic provider-keys -n $NS --from-literal=OPENAI_API_KEY=<rotated-key> \
        --from-literal=LANGSMITH_API_KEY=<rotated-key> && kubectl set env deployment/$AGENT -n $NS --from=secret/provider-keys
      ```
