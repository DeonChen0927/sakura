/** 极简 DOM 辅助：不引入外部框架与 CDN 资源。 */

export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'html') element.innerHTML = value;
    else if (key in element && key !== 'list') element[key] = value;
    else element.setAttribute(key, value === true ? '' : value);
  }
  append(element, children);
  return element;
}

function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

export const pill = (text, tone = 'gray') => h('span', { class: `pill ${tone}` }, text);

export function notice(kind, ...children) {
  return h('p', { class: `notice ${kind}` }, ...children);
}

export function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

export const shortCommit = (commit) => (commit ? String(commit).slice(0, 12) : '未知');

let toastTimer = null;
export function toast(message) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 4200);
}

/** 输入自动保存：保存失败必须可见（FR-06 / AC18）。 */
export function autosave(fn, delay = 600) {
  let timer = null;
  let pending = null;
  return (...args) => {
    pending = args;
    clearTimeout(timer);
    timer = setTimeout(() => {
      Promise.resolve(fn(...pending)).catch((error) => {
        toast(`保存失败：${error.message}`);
      });
    }, delay);
  };
}
