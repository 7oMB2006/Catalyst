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

// Project a series of terrain profiles from back to front. The opaque fill on
// each profile hides the lines behind the ridge, like a relief print.
function drawTerrain() {
  const canvas = document.querySelector("#terrain");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  canvas.width = 1160;
  canvas.height = 400;
  ctx.scale(2, 2);
  const paper = "#232824";
  const copper = ctx.createLinearGradient(15, 0, 578, 0);
  copper.addColorStop(0, paper);
  copper.addColorStop(.2, "#656952");
  copper.addColorStop(.48, "#e89261");
  copper.addColorStop(.69, "#ffae79");
  copper.addColorStop(1, "#a26949");
  ctx.fillStyle = "#444b41";
  for (let x = 24; x < 580; x += 14) {
    for (let y = 8; y < 200; y += 14) ctx.fillRect(x, y, 1, 1);
  }
  for (let row = 0; row <= 81; row++) {
    const y = (row - 36) / 25;
    ctx.beginPath();
    for (let x = -12; x <= 592; x += 2) {
      const u = (x - 325) / 110 + y * .29;
      const peak = Math.exp(-((u + .72) ** 2 * 1.5 + (y + .28) ** 2 * 1.12));
      const ridge = Math.exp(-((u - .9) ** 2 * 1.05 + (y - .18) ** 2 * .95));
      const saddle = Math.exp(-((u - .04) ** 2 * 2.8 + y ** 2 * 1.3));
      const height = 121 * peak + 108 * ridge - 33 * saddle;
      const py = 132 + y * 52 - height + 6 * Math.sin(u * 2.1 + y * 2.6);
      if (x === -12) ctx.moveTo(x, py);
      else ctx.lineTo(x, py);
    }
    ctx.lineTo(592, 230);
    ctx.lineTo(-12, 230);
    ctx.closePath();
    ctx.fillStyle = paper;
    ctx.fill();
    ctx.strokeStyle = copper;
    ctx.lineWidth = .85;
    ctx.stroke();
  }
}

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
  document.querySelector("#provider-prompt").hidden = Boolean(provider.value);
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
  for (const name of ["gemini", "stepfun"]) {
    const key = name.toUpperCase() + "_API_KEY";
    form.elements.namedItem(key).value = "";
    document.querySelector("#" + name + "-key").textContent = data.configured[key] ? "已配置 · 留空保留" : "未配置";
  }
  syncProvider();
  document.querySelector("#draft").hidden = true;
  document.querySelector("#location").textContent = data.envFile;
  snippet.textContent = JSON.stringify({ mcpServers: { catalyst: data.launch } }, null, 2);
}

function changedValues() {
  const values = {};
  for (const [name, value] of new FormData(form)) {
    const text = value.trim();
    if (name.endsWith("_API_KEY") ? text : current.values[name] !== text) values[name] = text;
  }
  return values;
}

form.addEventListener("input", event => {
  if (event.target.name === "CODEX_VIDEO_PROVIDER") syncProvider();
  document.querySelector("#draft").hidden = !Object.keys(changedValues()).length;
});
form.addEventListener("submit", async event => {
  event.preventDefault();
  const values = changedValues();
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
    const state = { ok: "通过", warning: "提醒", error: "异常" };
    checks.replaceChildren(...report.checks.map(check => {
      const item = document.createElement("li");
      item.dataset.state = check.status;
      item.textContent = check.id + " · " + state[check.status] + "　" + check.message + (check.hint ? " " + check.hint : "");
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

drawTerrain();
if (location.protocol === "file:") {
  show(settingsStatus, "在 Catalyst 目录运行 npm run setup，然后打开终端显示的本地地址。", "error");
} else {
  api("config").then(data => {
    fill(data);
    const endpoint = document.querySelector("#endpoint");
    endpoint.textContent = location.host;
    endpoint.hidden = false;
    editor.disabled = false;
    for (const button of [...hostButtons, copy]) button.disabled = false;
    show(settingsStatus, data.overrides.length ? "启动环境中的设置会覆盖文件中的同名设置。" : "");
  }).catch(error => show(settingsStatus, error.message, "error"));
}
