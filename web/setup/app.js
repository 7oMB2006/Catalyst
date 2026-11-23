"use strict";

const token = document.querySelector('meta[name="catalyst-setup"]').content;
const form = document.querySelector("#settings");
const editor = document.querySelector("#editor");
const settingsStatus = document.querySelector("#settings-status");
const hostStatus = document.querySelector("#host-status");
const provider = form.elements.namedItem("CODEX_VIDEO_PROVIDER");
const checks = document.querySelector("#checks");
const snippet = document.querySelector("#snippet");
const copy = document.querySelector("#copy");
const hostButtons = [...document.querySelectorAll("[data-host]")];
const show = (target, message, state = "") => { target.textContent = message; target.dataset.state = state; };
let current;

async function api(route, body) {
  const headers = { "x-catalyst-setup": token };
  const options = { headers };
  if (body !== undefined) {
    options.method = "POST";
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch("/api/" + route, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

function syncProvider() {
  for (const name of ["gemini", "stepfun"]) {
    const group = document.querySelector("#" + name + "-fields");
    group.hidden = provider.value !== name;
    for (const field of group.querySelectorAll("input")) field.disabled = group.hidden;
  }
  form.elements.namedItem("GEMINI_VIDEO_MODEL").required = provider.value === "gemini";
}

function fill(data) {
  current = data;
  for (const [key, value] of Object.entries(data.values)) {
    form.elements.namedItem(key).value = value;
  }
  provider.value = data.values.CODEX_VIDEO_PROVIDER;
  for (const name of ["gemini", "stepfun"]) {
    const key = name.toUpperCase() + "_API_KEY";
    form.elements.namedItem(key).value = "";
    document.querySelector("#" + name + "-key").textContent = data.configured[key] ? "已配置 · 留空保留" : "未配置";
  }
  syncProvider();
  document.querySelector("#location").textContent = data.envFile;
  snippet.textContent = JSON.stringify({ mcpServers: { catalyst: data.launch } }, null, 2);
}

provider.addEventListener("change", syncProvider);
form.addEventListener("submit", async event => {
  event.preventDefault();
  const values = {};
  for (const [name, value] of new FormData(form)) {
    const text = value.trim();
    if (name.endsWith("_API_KEY") ? text : current.values[name] !== text) values[name] = text;
  }
  if (!Object.keys(values).length) { show(settingsStatus, "没有需要保存的更改。"); return; }
  editor.disabled = true;
  show(settingsStatus, "正在保存…");
  try {
    fill(await api("config", { revision: current.revision, values }));
    checks.hidden = true;
    show(settingsStatus, "已保存。重启 Catalyst 连接后生效。", "ok");
  } catch (error) { show(settingsStatus, error.message, "error"); }
  finally { editor.disabled = false; }
});

document.querySelector("#doctor").addEventListener("click", async () => {
  editor.disabled = true;
  checks.hidden = true;
  show(settingsStatus, "正在检查本地工具和凭据状态…");
  try {
    const report = await api("doctor", {});
    checks.replaceChildren(...report.checks.map(check => {
      const item = document.createElement("li");
      item.dataset.state = check.status;
      item.textContent = check.id + " · " + check.message + (check.hint ? " " + check.hint : "");
      return item;
    }));
    checks.hidden = false;
    show(settingsStatus, (report.ok ? "本地检查完成。" : "有本地项需要处理。")
      + "此检查不会请求模型。" + (current.overrides.length ? "启动环境中的设置会覆盖文件中的同名设置。" : ""), report.ok ? "ok" : "error");
  } catch (error) { show(settingsStatus, error.message, "error"); }
  finally { editor.disabled = false; }
});

for (const button of hostButtons) {
  button.addEventListener("click", async () => {
    const host = button.dataset.host;
    const name = host === "codex" ? "Codex" : "Claude Code";
    for (const other of hostButtons) other.disabled = true;
    show(hostStatus, "正在接入 " + name + "…");
    try {
      const result = await api("hosts", { host });
      show(hostStatus, result.status === "already-registered" ? name + " 已指向这份配置。"
        : "已接入 " + name + "。请在宿主中重新启动连接。", "ok");
    } catch (error) { show(hostStatus, error.message, "error"); }
    finally { for (const other of hostButtons) other.disabled = false; }
  });
}

copy.addEventListener("click", async () => {
  const status = document.querySelector("#copy-status");
  try {
    await navigator.clipboard.writeText(snippet.textContent);
    show(status, "已复制。", "ok");
  } catch {
    show(status, "请选中上面的 JSON 手动复制。");
    const range = document.createRange();
    range.selectNodeContents(snippet);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    snippet.focus();
  }
});

api("config").then(data => {
  fill(data);
  editor.disabled = false;
  for (const button of [...hostButtons, copy]) button.disabled = false;
  show(settingsStatus, data.overrides.length ? "启动环境中的设置会覆盖文件中的同名设置。" : "");
}).catch(error => show(settingsStatus, error.message, "error"));
