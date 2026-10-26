/* eslint-disable simple-header/header -- code ported from MIT-licensed Undiscord Lite; port credit below */
// @ts-nocheck
/*
 * Ported from Undiscord Lite 1.3.0-zh (userscript, MIT, by OrbitalCheese).
 * That repository is no longer public. Undiscord Lite is itself derived from
 * victornpb/undiscord (MIT, https://github.com/victornpb/undiscord); the
 * original copyright notice is kept in THIRD-PARTY-NOTICES.md.
 * Mechanical split: bundled module registry converted to real ESM. Only the
 * marked adapter functions were rewritten; delete/search logic is upstream
 * verbatim.
 */

// ============================================================================
// PANEL DRAG / RESIZE
// ----------------------------------------------------------------------------
// Mouse-driven move and 8-directional resize for a fixed-positioned element.
// Move binds to a caller-supplied handle (typically the panel header); resize
// uses 8 invisible div edges/corners auto-injected around the element when
// createHandlers is true.
// ============================================================================

const MOVE = 0;
const RESIZE_T = 1;
const RESIZE_B = 2;
const RESIZE_L = 4;
const RESIZE_R = 8;
const RESIZE_TL = RESIZE_T + RESIZE_L;
const RESIZE_TR = RESIZE_T + RESIZE_R;
const RESIZE_BL = RESIZE_B + RESIZE_L;
const RESIZE_BR = RESIZE_B + RESIZE_R;

/** Wires drag-to-move and 8-corner resize onto an element. `moveHandle` is the inner element that grabs for moving (header / title bar). */
class DragResize {
  constructor({ elm, moveHandle, options }) {
    this.options = defaultArgs({
      minWidth: 200,
      maxWidth: Infinity,
      minHeight: 100,
      maxHeight: Infinity,
      draggingClass: "drag",
      createHandlers: true,
    }, options);

    elm.style.position = "fixed";

    new Draggable(elm, moveHandle, MOVE, this.options);

    if (this.options.createHandlers) {
      const sides = [
        ["grab-t", RESIZE_T], ["grab-r", RESIZE_R],
        ["grab-b", RESIZE_B], ["grab-l", RESIZE_L],
        ["grab-tl", RESIZE_TL], ["grab-tr", RESIZE_TR],
        ["grab-br", RESIZE_BR], ["grab-bl", RESIZE_BL],
      ];
      for (const [name, op] of sides) {
        const handle = createElement("div", { name }, elm);
        new Draggable(elm, handle, op, this.options);
      }
    }
  }
}

/** Binds mousedown / mousemove / mouseup on a handle to either move or resize the target element. Operation type is encoded in `op` (MOVE or a bitmask of RESIZE_T/B/L/R). */
class Draggable {
  constructor(targetElm, handleElm, op, options) {
    Object.assign(this, options);

    this._targetElm = targetElm;
    this._handleElm = handleElm;

    let vw = window.innerWidth;
    let vh = window.innerHeight;
    let initialX, initialY, initialT, initialL, initialW, initialH;

    const clamp = (v, min, max) => v < min ? min : v > max ? max : v;

    const moveOp = (x, y) => {
      const t = clamp(initialT + (y - initialY), 0, vh - initialH);
      const l = clamp(initialL + (x - initialX), 0, vw - initialW);
      this._targetElm.style.top = t + "px";
      this._targetElm.style.left = l + "px";
    };

    const resizeOp = (x, y) => {
      x = clamp(x, 0, vw);
      y = clamp(y, 0, vh);
      const dx = x - initialX;
      const dy = y - initialY;
      const dirX = (op & RESIZE_L) ? -1 : 1;
      const dirY = (op & RESIZE_T) ? -1 : 1;
      const dxClamped = clamp(dx * dirX, this.minWidth - initialW, this.maxWidth - initialW);
      const dyClamped = clamp(dy * dirY, this.minHeight - initialH, this.maxHeight - initialH);
      const t = initialT + dyClamped * dirY;
      const l = initialL + dxClamped * dirX;
      const w = initialW + dxClamped;
      const h = initialH + dyClamped;
      if (op & RESIZE_T) { this._targetElm.style.top = t + "px"; this._targetElm.style.height = h + "px"; }
      if (op & RESIZE_B) { this._targetElm.style.height = h + "px"; }
      if (op & RESIZE_L) { this._targetElm.style.left = l + "px"; this._targetElm.style.width = w + "px"; }
      if (op & RESIZE_R) { this._targetElm.style.width = w + "px"; }
    };

    const operation = op === MOVE ? moveOp : resizeOp;

    this._dragStartHandler = e => {
      if (e.buttons !== 1 && e.which !== 1) return;
      e.preventDefault();
      initialX = e.clientX;
      initialY = e.clientY;
      vw = window.innerWidth;
      vh = window.innerHeight;
      initialT = this._targetElm.offsetTop;
      initialL = this._targetElm.offsetLeft;
      initialW = this._targetElm.clientWidth;
      initialH = this._targetElm.clientHeight;
      document.addEventListener("mousemove", this._dragMoveHandler);
      document.addEventListener("mouseup", this._dragEndHandler);
      this._targetElm.classList.add(this.draggingClass);
    };

    this._dragMoveHandler = e => {
      e.preventDefault();
      // Mouse button released off-window — end the drag here.
      if ((e.buttons || e.which) !== 1) return this._dragEndHandler();
      operation(e.clientX, e.clientY);
    };

    this._dragEndHandler = () => {
      document.removeEventListener("mousemove", this._dragMoveHandler);
      document.removeEventListener("mouseup", this._dragEndHandler);
      this._targetElm.classList.remove(this.draggingClass);
    };

    this._handleElm.addEventListener("mousedown", this._dragStartHandler);
  }
}

/** Creates an element with the given attributes, appended to `parent` if supplied. */
function createElement(tag, attrs, parent) {
  const elm = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) elm.setAttribute(k, v);
  if (parent) parent.appendChild(elm);
  return elm;
}

/** Shallow-merges defined keys from `options` into `defaults`, returning the mutated defaults. */
function defaultArgs(defaults, options) {
  if (options && typeof options === "object") {
    for (const k in defaults) {
      if (options[k] !== undefined) defaults[k] = options[k];
    }
  }
  return defaults;
}

export default DragResize;
