// Deterministic Electron smoke: real app, preload and persistence; no model calls.
// Artifacts and user data are isolated in a temporary directory printed on completion.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { app, BrowserWindow, dialog } = require('electron')
const repo = path.resolve(__dirname, '../..')
const directory = fs.mkdtempSync('/tmp/meldwork-107-electron-')
app.setPath('userData', directory)
const workspaceModule = require(path.join(repo, 'desktop/src/workspace/local-workspace.cjs'))
const Original = workspaceModule.LocalWorkspace
let workspace
let calls = 0
const agents = [{ kind: 'codex', name: 'Codex CLI', executable: '/tmp/deterministic-agent', version: '0.120.0', resolvedVersion: '0.120.0', versionIdentified: true, compatibilityState: 'compatible' }]
const installer = require(path.join(repo, 'desktop/src/agents/installer/agent-installer.cjs'))
installer.AgentInstaller.prototype.detectedAgents = async () => agents
workspaceModule.LocalWorkspace = class extends Original {
  constructor(options) {
    super({ ...options, detectAgents: async () => agents, credentialState: async () => ({ state: 'ready', source: 'native-credential' }),
      captureAgentOutputs: async () => null, captureArtifactOutputs: async () => null, importAgentOutputs: async () => [],
      runAgent: async () => { calls++; return { text: `# Project brief ${calls}\n\nProgress: 3 of 4 milestones complete.\n\nSources: supplied task instructions only.\n\nUnresolved: budget needs confirmation.`, outcome: 'completed', sessionRef: 'smoke-session' } },
    })
    workspace = this
  }
}
dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(directory, 'delivery.md') })
require(path.join(repo, 'desktop/src/main.cjs'))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(fn) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(100) } throw new Error('timed out') }
async function run() {
  await waitFor(() => BrowserWindow.getAllWindows()[0] && workspace)
  const win = BrowserWindow.getAllWindows()[0]
  const js = expression => win.webContents.executeJavaScript(expression, true)
  await waitFor(() => js('Boolean(window.meldworkDesktop)'))
  await js(`localStorage.setItem('meldwork-onboarding-seen-v1','1'); localStorage.setItem('meldwork-locale','en')`)
  win.webContents.reload()
  await waitFor(() => js('Boolean(document.querySelector(".home-dashboard"))'))
  await workspace.refreshAgents()
  const group = await js(`window.meldworkDesktop.localWorkspace.createGroup({name:'Delivery smoke', conversationType:'direct', directAgentKind:'codex', workdir:${JSON.stringify(directory)}, allowWrite:false})`)
  await delay(500)
  await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Delivery smoke')).click()`)
  await waitFor(() => js('Boolean(document.querySelector(".delivery-bar"))'))
  await js(`document.querySelector('.delivery-bar button').click()`)
  await delay(100)
  fs.writeFileSync(path.join(directory, 'initial-ui.txt'), await js('document.body.innerText'))
  const click = async text => { await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`); await delay(150) }
  await click('New task')
  await click('Use project brief example')
  await click('Save')
  await waitFor(() => workspace.delivery.tasks.length === 1)
  await waitFor(() => js('Boolean(document.querySelector(".delivery-bar small"))'))
  fs.writeFileSync(path.join(directory, 'composer-ui.txt'), await js('document.body.innerText'))
  // Exercise the existing composer button and production preload/IPC.
  await click('Send')
  await waitFor(() => workspace.delivery.tasks[0].versions.length === 1)
  await waitFor(() => js('Boolean(document.querySelector(".delivery-check select"))'))
  await js(`document.querySelectorAll('.delivery-check select').forEach(s=>{s.value='met';s.dispatchEvent(new Event('change',{bubbles:true}))})`)
  await click('Accept this version')
  await waitFor(() => Boolean(workspace.delivery.tasks[0].versions[0].acceptedAt))
  await click('Export Markdown')
  assert.match(fs.readFileSync(path.join(directory, 'delivery.md'), 'utf8'), /Project brief 1/)
  await js(`const a=document.querySelector('.delivery-body form textarea');a.value='Make it shorter';a.dispatchEvent(new Event('input',{bubbles:true}))`)
  await click('Save revision request')
  await waitFor(() => Boolean(workspace.delivery.tasks[0].revision))
  await click('Send')
  await waitFor(() => workspace.delivery.tasks[0].versions.length === 2)
  assert.equal(workspace.delivery.tasks[0].versions[1].acceptedAt, '')
  assert.ok(workspace.delivery.tasks[0].versions[0].acceptedAt)
  await delay(500)
  fs.writeFileSync(path.join(directory, 'delivery-desktop.png'), (await win.webContents.capturePage()).toPNG())
  await click('Do again')
  await waitFor(() => workspace.delivery.tasks.length === 2)
  const copied = workspace.delivery.tasks[1]
  assert.equal(workspace.getGroup(copied.groupId).allowWrite, false)
  assert.equal(copied.attempts.length, 0)
  await delay(500)
  fs.writeFileSync(path.join(directory, 'reuse-ui.txt'), await js('document.body.innerText'))
  const reopened = new Original({ storagePath: workspace.storagePath, detectAgents: async () => agents, runAgent: async () => ({text:'unused'}), credentialState: async () => ({state:'ready'}) })
  assert.equal(reopened.delivery.tasks[0].versions.length, 2)
  assert.ok(reopened.delivery.tasks[0].versions[0].acceptedAt)
  win.setSize(640, 760)
  await delay(300)
  fs.writeFileSync(path.join(directory, 'delivery-narrow.png'), (await win.webContents.capturePage()).toPNG())
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, calls, directory, groupId: group.id, checks: ['create','composer-send','review','export','revision','version-isolation','reuse','persisted-reopen','narrow-window'] }, null, 2))
  console.log('SMOKE_OK', directory)
  app.quit()
}
run().catch(error => { console.error(error); fs.writeFileSync(path.join(directory, 'error.txt'), error.stack); console.error('SMOKE_DIR', directory); app.exit(1) })
