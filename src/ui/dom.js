/** Enough of a DOM helper to build the screens without a framework. */

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') el.className = value
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value)
    } else if (key in el && key !== 'list') {
      el[key] = value
    } else {
      el.setAttribute(key, value)
    }
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}

export function stat(label, value) {
  return h('div', { class: 'row' }, h('dt', {}, label), h('dd', { class: 'mono' }, value))
}
