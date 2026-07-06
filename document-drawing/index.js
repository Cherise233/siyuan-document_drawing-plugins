"use strict";
const siyuan = require("siyuan");

// 思源内置 API（参考资料来源：fetchPost + openByMobile 走原生导出流程）
var _siyuanFetchPost = siyuan.fetchPost || (typeof window !== "undefined" && window.fetchPost);
var _siyuanOpenByMobile = siyuan.openByMobile || (typeof window !== "undefined" && window.openByMobile);

// 跨平台兼容：桌面端有 fs/path，移动端没有
let fs = null;
let pathModule = null;
try { fs = require("fs"); } catch (e) { /* 移动端不可用 */ }
try { pathModule = require("path"); } catch (e) { /* 移动端不可用 */ }
const IS_DESKTOP = !!fs;

// 移动端 localStorage 键前缀
const LS_PREFIX = "dd_cfg_";
const LS_IMG_PREFIX = "dd_img_";

// ==================== DocumentManager ====================
class DocumentManager {
    constructor() {
        this._docId = null;
        this._docRect = null;
        this._onDocChange = null;
        this._editorEl = null;
        this._observer = null;
        this._pollTimer = null;
        this._clickHandler = null;
        this._focusHandler = null;
        this._rootIdResolver = null;  // UUID → root_id 解析函数
        this._resolvingUuid = null;   // 正在解析中的 UUID（防重复）
        this._lastUuid = null;        // 上次解析为 root_id 的 UUID
        this._lastTitle = null;       // 上次解析时的文档标题（切换文档检测）
        this._prevDocId = null;       // 切文档前的旧 root_id（传给 _onDocChange）
        this._resolveTimer = null;    // 延迟解析计时器
        // ★ 延迟启动监听——等 setRootIdResolver 注入后由外部调用 startWatch
    }

    // 注入 root_id 解析器并启动监听
    init(resolver) {
        this._rootIdResolver = resolver;
        this._startWatch();
        this.detectCurrentDocument();
    }

    // 注入 root_id 解析器（由插件提供 SQL 查询能力）
    setRootIdResolver(fn) { this._rootIdResolver = fn; }

    detectCurrentDocument() {
        try {
            let newId = null;
            const allEditors = document.querySelectorAll(".protyle-wysiwyg");

            // 第一步：用渲染尺寸定位可见编辑器
            let activeEditor = null;
            for (let i = 0; i < allEditors.length; i++) {
                const el = allEditors[i];
                const rect = el.getBoundingClientRect();
                if (rect.width > 100 && rect.height > 100) {
                    activeEditor = el;
                    break;
                }
            }
            if (!activeEditor && allEditors.length > 0) {
                activeEditor = allEditors[0];
            }

            // 第二步：从可见编辑器出发，多策略找文档 ID
            if (activeEditor) {
                const rect = activeEditor.getBoundingClientRect();
                this._docRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height || activeEditor.scrollHeight };
                this._editorEl = activeEditor;

                // 策略 A：向上遍历找 data-node-id（扩大搜索深度到 20 层）
                let el = activeEditor;
                for (let i = 0; i < 20; i++) {
                    if (!el) break;
                    if (el.getAttribute) {
                        const nid = el.getAttribute("data-node-id");
                        if (nid) { newId = nid; break; }
                    }
                    el = el.parentElement;
                }

                // 策略 B：找最近的 .protyle 容器
                if (!newId) {
                    const protyleEl = activeEditor.closest(".protyle");
                    if (protyleEl) {
                        newId = protyleEl.getAttribute("data-node-id")
                            || protyleEl.getAttribute("data-root-id")
                            || protyleEl.getAttribute("data-id")
                            || (protyleEl.id && protyleEl.id.replace("protyle-", ""))
                            || null;
                    }
                }

                // 策略 C：找最近带 data-node-id 的元素（不限 class）
                if (!newId) {
                    const nodeEl = activeEditor.closest("[data-node-id]");
                    if (nodeEl) newId = nodeEl.getAttribute("data-node-id");
                }
            }

            // 策略 D：全局搜索——找当前可见的带 data-node-id 的 protyle 容器
            if (!newId) {
                const visibleProtyles = document.querySelectorAll(".protyle[data-node-id], [data-node-id]");
                for (let i = 0; i < visibleProtyles.length; i++) {
                    const p = visibleProtyles[i];
                    // 检查是否包含可见的编辑器
                    const inner = p.querySelector(".protyle-wysiwyg");
                    if (inner) {
                        const r = inner.getBoundingClientRect();
                        if (r.width > 100 && r.height > 100) {
                            newId = p.getAttribute("data-node-id");
                            if (newId) break;
                        }
                    }
                }
            }

            // 策略 E：思源 API / URL hash（最后后备）
            if (!newId) {
                try {
                    if (window.siyuan && window.siyuan.editor) {
                        newId = window.siyuan.editor.protyle?.block?.rootID;
                    }
                    if (!newId && window.editor) {
                        newId = window.editor.protyle?.block?.rootID;
                    }
                    if (!newId && window.location.hash) {
                        const m = location.hash.match(/#\/([^\?&#]+)/);
                        if (m) newId = m[1];
                    }
                } catch (e) { /* ignore */ }
            }

            if (!newId) {
                console.log("[DocumentManager] detectCurrentDocument FAILED — editors:", allEditors.length,
                    "activeEditor:", !!activeEditor,
                    "hash:", window.location.hash?.slice(0, 30),
                    "siyuan:", !!(window.siyuan && window.siyuan.editor));
                if (!this._docId) this._docId = "_unknown_" + Date.now();
                return;
            }

            // ★ 判断 ID 类型
            var isRootId = /^\d{14}-[a-z0-9]{7}$/.test(newId);
            var isUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(newId);

            // ★ 已有 root_id → 稳定！UUID 变化只更新引用，不清理 root_id
            if (this._docId && /^\d{14}-[a-z0-9]{7}$/.test(this._docId) && isUuid) {
                if (newId !== this._lastUuid) {
                    this._lastUuid = newId;
                    var curTitle = "";
                    try { curTitle = this.getDocumentTitle(); } catch (e) {}
                    if (curTitle && this._lastTitle && curTitle !== this._lastTitle) {
                        console.log("[DocumentManager] title changed, re-resolving:", this._lastTitle, "→", curTitle);
                        this._prevDocId = this._docId;
                        this._lastTitle = curTitle;
                        // ★ 立即触发保存旧文档（通过 _onDocChange 模拟）
                        if (this._onDocChange) this._onDocChange(null, this._docId);
                        this._docId = null;
                    } else if (!this._lastTitle) {
                        this._lastTitle = curTitle;
                    }
                }
                if (this._docId) return;
            }

            // ★ root_id 没变 → 跳过
            if (newId === this._docId && !isUuid) return;
            // UUID 没变且正在解析 → 跳过
            if (isUuid && this._resolvingUuid === newId) return;

            // ★ UUID：先解析为 root_id 再设置 _docId
            if (isUuid && this._rootIdResolver) {
                this._resolvingUuid = newId;
                var self = this;
                // ★ 延迟 300ms 再解析：切文档时 DOM 事件先到，标签页标题可能还没更新
                // 如果立刻 getDocumentTitle() 会拿到旧文档的标题 → 两个文档串 ID
                clearTimeout(this._resolveTimer);
                this._resolveTimer = setTimeout(function () {
                    if (self._resolvingUuid !== newId) return;
                    self._resolvingUuid = null;
                    var title = "";
                    try { title = self.getDocumentTitle(); } catch (e) {}
                    console.log("[DocumentManager] resolving UUID → root_id:", title);
                    self._rootIdResolver(newId, title, function (rootId) {
                        if (rootId && /^\d{14}-[a-z0-9]{7}$/.test(rootId) && rootId !== self._docId) {
                            // ★ oldId：优先用切文档时保存的 _prevDocId，否则用当前 _docId
                            var old = self._prevDocId || self._docId;
                            self._prevDocId = null;
                            self._docId = rootId;
                            self._lastUuid = newId;
                            self._lastTitle = title;
                            console.log("[DocumentManager] resolved:", rootId, "title:", title, "old:", old);
                            if (self._onDocChange) self._onDocChange(rootId, old);
                        } else if (!rootId) {
                            console.log("[DocumentManager] resolution failed for:", title);
                        }
                    });
                }, 300);
                return;
            }

            // ★ 其他情况：直接使用
            console.log("[DocumentManager] document changed:", this._docId, "->", newId);
            var oldId = this._docId;
            this._docId = newId;
            if (newId && /^\d{14}-[a-z0-9]{7}$/.test(newId)) this._lastUuid = null;  // root_id 直接用的，不记 UUID
            if (this._onDocChange) this._onDocChange(newId, oldId);
        } catch (e) { console.warn("[DocumentManager] detectCurrentDocument error:", e); }
    }

    _startWatch() {
        const self = this;
        let ticking = false;
        const scheduleCheck = function () {
            if (!ticking) {
                ticking = true;
                setTimeout(function () {
                    self.detectCurrentDocument();
                    ticking = false;
                }, 150);
            }
        };
        this._observer = new MutationObserver(function () {
            scheduleCheck();
        });
        // 监听更多可能触发文档切换的变化：
        // - childList/subtree: DOM 增删（新开/关闭标签）
        // - attributes: class 变化（标签切换时 class 可能改变）
        // - characterData: 文档内容变化
        this._observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["data-node-id", "class", "style"],
            characterData: false
        });
        // 额外：监听点击事件（用户点击标签页 / 文件树切换文档）
        this._clickHandler = function (e) {
            const target = e.target;
            if (target && (target.closest(".layout-tab-bar") || target.closest('[data-type="tab-header"]')
                || target.closest(".file-tree") || target.closest(".sy__file")
                || target.closest('[data-type="tab-header"]'))) {
                setTimeout(function () { self.detectCurrentDocument(); }, 300);
            }
        };
        document.addEventListener("click", this._clickHandler, true);
        // 额外：监听 focusin（用户点击不同编辑器时触发）
        this._focusHandler = function (e) {
            if (e.target && e.target.closest && e.target.closest(".protyle-wysiwyg")) {
                setTimeout(function () { self.detectCurrentDocument(); }, 200);
            }
        };
        document.addEventListener("focusin", this._focusHandler, true);
        console.log("[DocumentManager] MutationObserver + click/focusin listeners started");
        // 立即检测一次
        this.detectCurrentDocument();
        // 后备：轮询检测（每 2 秒检查一次，防止 MutationObserver 漏掉）
        this._pollTimer = setInterval(function () {
            self.detectCurrentDocument();
        }, 2000);
    }

    stopWatch() {
        if (this._observer) { this._observer.disconnect(); this._observer = null; }
        if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
        if (this._clickHandler) { document.removeEventListener("click", this._clickHandler, true); this._clickHandler = null; }
        if (this._focusHandler) { document.removeEventListener("focusin", this._focusHandler, true); this._focusHandler = null; }
    }
    getDocumentID() { if (!this._docId) this.detectCurrentDocument(); return this._docId || null; }
    getDocumentDOM() {
        // 优先通过文档 ID 定位对应的编辑器
        const allEditors = document.querySelectorAll(".protyle-wysiwyg");
        if (this._docId) {
            for (let i = 0; i < allEditors.length; i++) {
                const el = allEditors[i];
                let parent = el.parentElement;
                for (let j = 0; j < 10; j++) {
                    if (parent && parent.getAttribute && parent.getAttribute("data-node-id") === this._docId) {
                        return el;
                    }
                    parent = parent && parent.parentElement;
                }
            }
        }
        // 后备：用渲染尺寸找可见编辑器
        for (let i = 0; i < allEditors.length; i++) {
            const rect = allEditors[i].getBoundingClientRect();
            if (rect.width > 100 && rect.height > 100) return allEditors[i];
        }
        return allEditors.length > 0 ? allEditors[0] : null;
    }
    getDocumentRect() {
        // 实时从激活编辑器获取位置，避免使用过期的缓存
        const editor = this.getDocumentDOM();
        if (editor) {
            const rect = editor.getBoundingClientRect();
            this._docRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height || editor.scrollHeight };
            this._editorEl = editor;
        }
        return this._docRect || { left: 0, top: 0, width: 800, height: 600 };
    }
    getEditorElement() { return this.getDocumentDOM(); }
    getDocumentTitle() {
        // 尝试多种方式获取文档标题
        try {
            // 方式1：思源 API
            if (window.siyuan && window.siyuan.editor && window.siyuan.editor.protyle) {
                var t = window.siyuan.editor.protyle.block?.title || window.siyuan.editor.protyle.title;
                if (t) return t;
            }
            // 方式2：从编辑器 DOM 找标题元素
            var editor = this.getDocumentDOM();
            if (editor) {
                var titleEl = editor.closest(".protyle")?.querySelector(".protyle-title__input")
                    || editor.closest('[data-node-id]')?.querySelector(".protyle-title__input");
                if (titleEl && titleEl.textContent) return titleEl.textContent.trim();
            }
            // 方式3：标签页标题
            var tab = document.querySelector('.layout-tab-bar .item--focus');
            if (tab && tab.textContent) return tab.textContent.trim();
        } catch (e) {}
        return "";
    }
    onDocChange(fn) { this._onDocChange = fn; }
}

// ==================== LayerManager ====================
class LayerManager {
    constructor() {
        this._layers = [];
        this._currentLayerId = null;
        this._onLayersChanged = null;
        this._nextId = 1;
    }

    setOnLayersChanged(fn) { this._onLayersChanged = fn; }
    _notify() { if (this._onLayersChanged) { try { this._onLayersChanged(this._layers); } catch (e) {} } }

    createLayer(name) {
        const layer = {
            id: this._nextId++,
            name: name || ("图层 " + (this._nextId - 1)),
            visible: true,
            canvas: null,
            ctx: null,
            history: [],
            file: null
        };
        this._layers.push(layer);
        this._currentLayerId = layer.id;
        this._notify();
        return layer;
    }

    deleteLayer(id) {
        this._layers = this._layers.filter(l => l.id !== id);
        if (this._currentLayerId === id) {
            this._currentLayerId = this._layers.length > 0 ? this._layers[this._layers.length - 1].id : null;
        }
        this._nextId = this._layers.length > 0 ? Math.max(...this._layers.map(l => l.id)) + 1 : 1;
        this._notify();
    }

    showLayer(id) { const l = this._getLayer(id); if (l) { l.visible = true; this._notify(); } }
    hideLayer(id) { const l = this._getLayer(id); if (l) { l.visible = false; this._notify(); } }
    renameLayer(id, name) { const l = this._getLayer(id); if (l) { l.name = name; this._notify(); } }
    setCurrentLayer(id) { this._currentLayerId = id; this._notify(); }
    getCurrentLayer() { return this._getLayer(this._currentLayerId); }
    getCurrentLayerId() { return this._currentLayerId; }
    getLayers() { return this._layers; }
    getLayer(id) { return this._layers.find(l => l.id === id) || null; }

    loadFromConfig(config) {
        if (!config || !config.layers) return;
        this._layers = config.layers.map(l => ({
            id: l.id, name: l.name || ("图层 " + l.id),
            visible: l.visible !== false, canvas: null, ctx: null, history: [], file: l.file || null
        }));
        this._currentLayerId = config.currentLayer || (this._layers.length > 0 ? this._layers[0].id : null);
        this._nextId = this._layers.length > 0 ? Math.max(...this._layers.map(l => l.id)) + 1 : 1;
        this._notify();
    }

    toConfig() {
        return {
            currentLayer: this._currentLayerId,
            layers: this._layers.map(l => ({ id: l.id, name: l.name, visible: l.visible, file: l.file }))
        };
    }

    bindCanvas(layerId, canvas) {
        const l = this._getLayer(layerId);
        if (l) { l.canvas = canvas; l.ctx = canvas.getContext("2d"); }
    }

    _getLayer(id) { return this._layers.find(l => l.id === id) || null; }
}

// ==================== CanvasManager ====================
class CanvasManager {
    constructor() {
        this._canvases = {};
        this._currentLayerId = null;
        this._currentTool = "brush";
        this._brushSize = 3;
        this._brushColor = "#000000";
        this._brushOpacity = 1;       // 画笔不透明度
        this._highlighterOpacity = 0.6; // 荧光笔不透明度（默认60%）
        this._currentOpacity = 1;     // 当前生效的不透明度
        this._highlighterSize = 20;   // 荧光笔粗细
        this._currentSize = 3;        // 当前生效的粗细
        this._drawing = false;
        this._lastX = 0;
        this._lastY = 0;
        this._lastMidX = 0;  // 贝塞尔曲线平滑：上一段的中点
        this._lastMidY = 0;

        // 手指双击切换画笔/橡皮
        this._lastFingerTapTime = 0;
        this._lastFingerTapX = 0;
        this._lastFingerTapY = 0;
        this._touchStartTime = 0;
        this._touchMoved = false;
        this._onToolChange = null;  // 工具切换回调 → 插件更新工具栏高亮
        this._onNotify = null;     // 通知回调 → 插件显示消息提醒

        // 手势开关（从设置同步）
        this._fingerDoubleTapEnabled = true;
        this._twoFingerUndoEnabled = true;

        // 选择工具状态
        this._selecting = false;
        this._selectStartX = 0;
        this._selectStartY = 0;
        this._hasSelection = false;
        this._selX = 0; this._selY = 0; this._selW = 0; this._selH = 0;
        this._selectedImageData = null;  // 选中区域的 ImageData（移动时用）

        // 移动状态
        this._isMoving = false;
        this._moveStartX = 0;
        this._moveStartY = 0;
        this._floatCanvas = null;  // 移动时的浮动预览

        // 选框 DOM
        this._selectionRect = null;

        // 手指触摸滚动状态（平板端：笔写字，手指滚动页面）
        this._touchScrolling = false;
        this._touchStartX = 0;
        this._touchStartY = 0;
        this._touchScrollStartX = 0;
        this._touchScrollStartY = 0;
        this._scrollContainer = null;  // 缓存的滚动容器

        // 多指手势（双指点击撤销）
        this._activeTouchCount = 0;
        this._twoFingerTapPossible = false;
        this._twoFingerStartTime = 0;

        // 撤销历史
        this._history = [];        // canvas 快照栈（dataURL）
        this._maxHistory = 30;
    }

    // ========== 撤销 ==========
    pushHistory() {
        const canvas = this.getCurrentCanvas();
        if (!canvas) return;
        // 限制历史栈大小
        if (this._history.length >= this._maxHistory) this._history.shift();
        this._history.push(canvas.toDataURL("image/png"));
    }

    undo() {
        const canvas = this.getCurrentCanvas();
        if (!canvas || this._history.length === 0) return false;
        const prev = this._history.pop();
        const ctx = canvas.getContext("2d");
        const img = new Image();
        img.onload = function () {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);
        };
        img.src = prev;
        return true;
    }

    clearHistory() {
        this._history = [];
    }

    // ========== 选框 DOM ==========
    _ensureSelectionRect() {
        if (this._selectionRect && document.body.contains(this._selectionRect)) return this._selectionRect;
        const rect = document.createElement("div");
        rect.className = "drawing-selection-rect";
        rect.style.cssText = "position:absolute;border:2px dashed #1890ff;background:rgba(24,144,255,0.08);" +
            "pointer-events:none;z-index:20;display:none;box-sizing:border-box;";
        this._selectionRect = rect;
        // 添加右上角叉号按钮
        const closeBtn = document.createElement("button");
        closeBtn.className = "drawing-selection-close";
        closeBtn.innerHTML = "✕";
        closeBtn.style.cssText = "position:absolute;top:-12px;right:-12px;width:24px;height:24px;" +
            "background:#ff4d4f;color:#fff;border:none;border-radius:50%;cursor:pointer;" +
            "font-size:14px;line-height:24px;text-align:center;pointer-events:auto;" +
            "box-shadow:0 2px 6px rgba(0,0,0,0.15);z-index:21;display:none;";
        closeBtn.onclick = (e) => {
            e.stopPropagation();
            this.deleteSelection();
        };
        rect._closeBtn = closeBtn;
        rect.appendChild(closeBtn);
        return rect;
    }

    _showSelectionRect(x, y, w, h) {
        const rect = this._ensureSelectionRect();
        rect.style.left = x + "px";
        rect.style.top = y + "px";
        rect.style.width = w + "px";
        rect.style.height = h + "px";
        rect.style.display = "";

        // 只在框选完成后显示叉号按钮（_hasSelection 为 true 时）
        if (rect._closeBtn) {
            if (this._hasSelection && !this._selecting && !this._isMoving) {
                rect._closeBtn.style.display = "";
            } else {
                rect._closeBtn.style.display = "none";
            }
        }
        const canvas = this.getCurrentCanvas();
        if (canvas && canvas.parentNode && rect.parentNode !== canvas.parentNode) {
            try { canvas.parentNode.appendChild(rect); } catch (e) {}
        }
    }

    _hideSelectionRect() {
        if (this._selectionRect) {
            this._selectionRect.style.display = "none";
            // 隐藏叉号按钮
            if (this._selectionRect._closeBtn) {
                this._selectionRect._closeBtn.style.display = "none";
            }
        }
    }

    _removeSelectionRect() {
        if (this._selectionRect) {
            if (this._selectionRect.parentNode) this._selectionRect.parentNode.removeChild(this._selectionRect);
            this._selectionRect = null;
        }
    }

    _removeFloatCanvas() {
        if (this._floatCanvas && this._floatCanvas.parentNode) {
            this._floatCanvas.parentNode.removeChild(this._floatCanvas);
        }
        this._floatCanvas = null;
    }

    // ========== 工具切换 ==========
    setTool(tool) {
        if (tool !== this._currentTool) {
            this.clearSelection();
            // 切换工具时切换对应透明度和粗细
            if (tool === "highlighter") {
                this._currentOpacity = this._highlighterOpacity;
                this._currentSize = this._highlighterSize;
            } else if (this._currentTool === "highlighter") {
                this._currentOpacity = this._brushOpacity;
                this._currentSize = this._brushSize;
            }
        }
        this._currentTool = tool;
        this._updatePointerEvents();
        if (this._onToolChange) this._onToolChange(tool);
    }

    onToolChange(fn) { this._onToolChange = fn; }
    onNotify(fn) { this._onNotify = fn; }

    setGestureSettings(fingerDoubleTap, twoFingerUndo) {
        this._fingerDoubleTapEnabled = fingerDoubleTap !== false;
        this._twoFingerUndoEnabled = twoFingerUndo !== false;
    }

    _notify(msg) {
        if (this._onNotify) this._onNotify(msg);
    }

    _togglePenTool() {
        // 双击笔：画笔↔橡皮，其他工具→先切橡皮
        if (this._currentTool === "brush") {
            this.setTool("eraser");
        } else if (this._currentTool === "eraser") {
            this.setTool("brush");
        } else {
            this.setTool("eraser");
        }
    }

    setBrushSize(size) {
        this._currentSize = size;
        if (this._currentTool === "highlighter") {
            this._highlighterSize = size;
        } else {
            this._brushSize = size;
        }
    }
    setBrushColor(color) { this._brushColor = color; }
    setBrushOpacity(opacity) {
        var v = Math.max(0.05, Math.min(1, parseFloat(opacity) || 1));
        this._currentOpacity = v;
        // 保存到当前工具对应的默认透明度
        if (this._currentTool === "highlighter") {
            this._highlighterOpacity = v;
        } else {
            this._brushOpacity = v;
        }
    }

    _updatePointerEvents() {
        Object.values(this._canvases).forEach(c => { c.style.pointerEvents = "none"; c.classList.remove("active-layer"); });
        const current = this.getCurrentCanvas();
        if (current) { current.style.pointerEvents = "auto"; current.classList.add("active-layer"); }
    }

    // ========== 选择操作 ==========
    clearSelection() {
        this._hasSelection = false;
        this._selecting = false;
        this._isMoving = false;
        this._selectedImageData = null;
        this._selX = this._selY = this._selW = this._selH = 0;
        this._hideSelectionRect();
        this._removeFloatCanvas();
    }

    deleteSelection() {
        if (!this._hasSelection) return false;
        const canvas = this.getCurrentCanvas();
        if (!canvas) return false;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(this._selX, this._selY, this._selW, this._selH);
        this.clearSelection();
        return true;
    }

    // ========== Canvas 管理 ==========
    createCanvas(layerId, width, height) {
        const canvas = document.createElement("canvas");
        canvas.width = width || 800;
        canvas.height = height || 600;
        canvas.classList.add("drawing-overlay-canvas");
        canvas.dataset.layerId = layerId;
        this._canvases[layerId] = canvas;
        this._bindEvents(canvas);
        this._updatePointerEvents();
        return canvas;
    }

    // 调整所有 canvas 尺寸（保留原有内容）
    resizeCanvases(newWidth, newHeight) {
        Object.values(this._canvases).forEach(canvas => {
            if (!canvas) return;
            const oldWidth = canvas.width;
            const oldHeight = canvas.height;
            if (newWidth === oldWidth && newHeight === oldHeight) return;

            // 保存完整的旧内容
            const tempCanvas = document.createElement("canvas");
            tempCanvas.width = oldWidth;
            tempCanvas.height = oldHeight;
            const tempCtx = tempCanvas.getContext("2d");
            tempCtx.drawImage(canvas, 0, 0);

            // 调整尺寸（这会自动清空 canvas）
            canvas.width = newWidth;
            canvas.height = newHeight;

            // 恢复旧内容（绘制到左上角）
            const ctx = canvas.getContext("2d");
            ctx.drawImage(tempCanvas, 0, 0);
        });
    }

    removeCanvas(layerId) {
        const canvas = this._canvases[layerId];
        if (canvas) { if (canvas.parentNode) canvas.parentNode.removeChild(canvas); delete this._canvases[layerId]; }
        if (this._currentLayerId === layerId) this.clearSelection();
    }

    // ========== 事件绑定（画笔 / 橡皮 / 选择 / 移动） ==========
    // 使用 Pointer Events API 区分：笔(pen)写字，手指(touch)滚动页面，鼠标(mouse)绘制
    _bindEvents(canvas) {
        const self = this;
        // 禁止浏览器默认触摸行为（否则手指滑动会触发浏览器缩放/导航）
        canvas.style.touchAction = "none";

        // 找到可滚动的祖先容器（SiYuan 编辑器内是 .protyle-content）
        let _cachedScrollContainer = null;
        const getScrollContainer = function () {
            if (_cachedScrollContainer) return _cachedScrollContainer;
            let el = canvas.parentElement;
            while (el) {
                const s = getComputedStyle(el);
                if (s.overflowY === "auto" || s.overflowY === "scroll" ||
                    s.overflow === "auto" || s.overflow === "scroll") {
                    _cachedScrollContainer = el;
                    return el;
                }
                el = el.parentElement;
            }
            _cachedScrollContainer = document.scrollingElement || document.documentElement;
            return _cachedScrollContainer;
        };

        // ========== pointerdown ==========
        canvas.onpointerdown = function (e) {
            // ★ 手指触摸 → 滚动页面 / 双击检测 / 双指撤销
            if (e.pointerType === "touch") {
                self._activeTouchCount++;
                if (self._activeTouchCount === 2) {
                    // 第二指按下 → 可能是双指点击撤销（重置移动标记，忽略此前第一指的微动）
                    self._twoFingerTapPossible = true;
                    self._twoFingerStartTime = Date.now();
                    self._touchMoved = false;
                } else if (self._activeTouchCount > 2) {
                    self._twoFingerTapPossible = false;
                }
                // 仅在第一指时初始化滚动状态
                if (self._activeTouchCount === 1) {
                    self._touchScrolling = true;
                    self._touchMoved = false;
                    self._touchStartX = e.clientX;
                    self._touchStartY = e.clientY;
                    self._touchStartTime = Date.now();
                    const sc = getScrollContainer();
                    self._touchScrollStartX = sc.scrollLeft || 0;
                    self._touchScrollStartY = sc.scrollTop || 0;
                    canvas.setPointerCapture(e.pointerId);  // 仅捕获第一指
                }
                // 第二指及之后不捕获（避免释放第一指捕获导致事件丢失）
                e.preventDefault();
                return;
            }

            // === 笔 (pen) 或鼠标 (mouse) ===

            if (self._currentTool !== "select") {
                // 画笔 / 橡皮模式：保存快照以便撤销
                self.pushHistory();
                self._drawing = true;
                const r = canvas.getBoundingClientRect();
                const px = e.clientX - r.left;
                const py = e.clientY - r.top;
                self._lastX = px;
                self._lastY = py;
                self._lastMidX = px;  // 初始化贝塞尔中点
                self._lastMidY = py;
                canvas.setPointerCapture(e.pointerId);
                e.preventDefault();
                return;
            }

            // 选择模式
            const r = canvas.getBoundingClientRect();
            const x = e.clientX - r.left;
            const y = e.clientY - r.top;

            // 如果已有选区且点击在选区内 → 开始移动
            if (self._hasSelection && x >= self._selX && x <= self._selX + self._selW &&
                y >= self._selY && y <= self._selY + self._selH) {
                self._isMoving = true;
                self._moveStartX = x;
                self._moveStartY = y;
                const ctx = canvas.getContext("2d");
                self._selectedImageData = ctx.getImageData(self._selX, self._selY, self._selW, self._selH);
                ctx.clearRect(self._selX, self._selY, self._selW, self._selH);
                self._removeFloatCanvas();
                const float = document.createElement("canvas");
                float.width = self._selW;
                float.height = self._selH;
                float.style.cssText = "position:absolute;pointer-events:none;z-index:25;opacity:0.85;" +
                    "left:" + self._selX + "px;top:" + self._selY + "px;";
                float.getContext("2d").putImageData(self._selectedImageData, 0, 0);
                if (canvas.parentNode) canvas.parentNode.appendChild(float);
                self._floatCanvas = float;
                self._hideSelectionRect();
                canvas.setPointerCapture(e.pointerId);
                e.preventDefault();
                return;
            }

            // 点击在选区外 → 清除旧选区，开始框选
            self.clearSelection();
            self._selecting = true;
            self._selectStartX = x;
            self._selectStartY = y;
            canvas.setPointerCapture(e.pointerId);
            e.preventDefault();
        };

        // ========== pointermove ==========
        canvas.onpointermove = function (e) {
            // 手指触摸 → 滚动页面（双指期间不滚动，等待判定是否为双指点击）
            if (self._touchScrolling && self._activeTouchCount < 2) {
                const dx = e.clientX - self._touchStartX;
                const dy = e.clientY - self._touchStartY;
                // 手指移动超过阈值 → 标记为滚动，取消任何点击手势
                if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
                    self._touchMoved = true;
                }
                const sc = getScrollContainer();
                if (sc === document.scrollingElement || sc === document.documentElement) {
                    window.scrollTo(self._touchScrollStartX - dx, self._touchScrollStartY - dy);
                } else {
                    sc.scrollLeft = self._touchScrollStartX - dx;
                    sc.scrollTop = self._touchScrollStartY - dy;
                }
                return;
            }

            const r = canvas.getBoundingClientRect();
            const x = e.clientX - r.left;
            const y = e.clientY - r.top;

            // 框选中
            if (self._selecting) {
                const sx = Math.min(self._selectStartX, x);
                const sy = Math.min(self._selectStartY, y);
                const sw = Math.abs(x - self._selectStartX);
                const sh = Math.abs(y - self._selectStartY);
                self._showSelectionRect(sx, sy, sw, sh);
                return;
            }

            // 移动中
            if (self._isMoving) {
                const dx = x - self._moveStartX;
                const dy = y - self._moveStartY;
                if (self._floatCanvas) {
                    self._floatCanvas.style.left = (self._selX + dx) + "px";
                    self._floatCanvas.style.top = (self._selY + dy) + "px";
                }
                return;
            }

            // 绘制
            if (!self._drawing) return;
            if ((self._currentTool === "brush" || self._currentTool === "highlighter")) self._drawBrush(self._lastX, self._lastY, x, y);
            if (self._currentTool === "eraser") self._drawEraser(x, y);
            self._lastX = x;
            self._lastY = y;
        };

        // ========== pointerup ==========
        canvas.onpointerup = function (e) {
            // 手指触摸结束 → 双指撤销 / 双击检测 / 滚动结束
            if (self._touchScrolling) {
                self._activeTouchCount--;
                // ★ 从 2→1 时立即判定双指（不等第二指 pointerup，它在平板上可能丢失）
                if (self._twoFingerUndoEnabled && self._activeTouchCount === 1 &&
                    self._twoFingerTapPossible && !self._touchMoved &&
                    Date.now() - self._twoFingerStartTime < 500) {
                    self._twoFingerTapPossible = false;
                    self._activeTouchCount = 0;
                    self._touchScrolling = false;
                    if (self.undo()) {
                        self._notify("↩️ 已撤销");
                    }
                    try { canvas.releasePointerCapture(e.pointerId); } catch (ex) {}
                    return;
                }
                if (self._activeTouchCount <= 0) {
                    self._activeTouchCount = 0;
                    self._touchScrolling = false;
                    // ★ 双指点击撤销（短时间、未移动、两根手指）
                    if (self._twoFingerTapPossible && !self._touchMoved &&
                        Date.now() - self._twoFingerStartTime < 400) {
                        self._twoFingerTapPossible = false;
                        if (self.undo()) {
                            self._notify("↩️ 已撤销");
                        }
                        try { canvas.releasePointerCapture(e.pointerId); } catch (ex) {}
                        return;
                    }
                    // 手指双击检测：短时间、未移动 → 点击事件
                    if (!self._touchMoved && Date.now() - self._touchStartTime < 300) {
                        if (self._fingerDoubleTapEnabled &&
                            self._lastFingerTapTime > 0 && Date.now() - self._lastFingerTapTime < 350 &&
                            Math.abs(e.clientX - self._lastFingerTapX) < 40 &&
                            Math.abs(e.clientY - self._lastFingerTapY) < 40) {
                            // ★ 手指双击！切换画笔/橡皮
                            self._lastFingerTapTime = 0;
                            self._togglePenTool();
                        } else {
                            // 第一次点击，记录
                            self._lastFingerTapTime = Date.now();
                            self._lastFingerTapX = e.clientX;
                            self._lastFingerTapY = e.clientY;
                        }
                    }
                }
                try { canvas.releasePointerCapture(e.pointerId); } catch (ex) {}
                return;
            }

            // 框选结束
            if (self._selecting) {
                self._selecting = false;
                const r2 = canvas.getBoundingClientRect();
                const x2 = e.clientX - r2.left;
                const y2 = e.clientY - r2.top;
                const sx = Math.min(self._selectStartX, x2);
                const sy = Math.min(self._selectStartY, y2);
                const sw = Math.abs(x2 - self._selectStartX);
                const sh = Math.abs(y2 - self._selectStartY);
                if (sw > 5 && sh > 5) {
                    self._hasSelection = true;
                    self._selX = sx; self._selY = sy;
                    self._selW = sw; self._selH = sh;
                    self._showSelectionRect(sx, sy, sw, sh);
                } else {
                    self._hideSelectionRect();
                }
                try { canvas.releasePointerCapture(e.pointerId); } catch (ex) {}
                return;
            }

            // 移动结束
            if (self._isMoving) {
                self._isMoving = false;
                const r3 = canvas.getBoundingClientRect();
                const x3 = e.clientX - r3.left;
                const y3 = e.clientY - r3.top;
                const dx = x3 - self._moveStartX;
                const dy = y3 - self._moveStartY;
                const newX = self._selX + dx;
                const newY = self._selY + dy;
                if (self._selectedImageData) {
                    const ctx = canvas.getContext("2d");
                    ctx.putImageData(self._selectedImageData, newX, newY);
                }
                self._removeFloatCanvas();
                self._selectedImageData = null;
                self._selX = newX;
                self._selY = newY;
                self._showSelectionRect(self._selX, self._selY, self._selW, self._selH);
                try { canvas.releasePointerCapture(e.pointerId); } catch (ex) {}
                return;
            }

            if (self._drawing && (self._currentTool === "brush" || self._currentTool === "highlighter")) {
                self._finishBrushStroke(self._lastX, self._lastY);
            }
            self._drawing = false;
            try { canvas.releasePointerCapture(e.pointerId); } catch (ex) {}
        };

        // ========== pointerleave / pointercancel ==========
        const cancelAll = function () {
            if (self._touchScrolling) {
                self._touchScrolling = false;
                self._activeTouchCount = 0;
                self._twoFingerTapPossible = false;
                return;
            }
            if (self._selecting) {
                self._selecting = false;
                self._hideSelectionRect();
            }
            if (self._isMoving) {
                if (self._selectedImageData) {
                    const ctx = canvas.getContext("2d");
                    ctx.putImageData(self._selectedImageData, self._selX, self._selY);
                }
                self._removeFloatCanvas();
                self._selectedImageData = null;
                self._isMoving = false;
                self._hasSelection = false;
            }
            if (self._drawing && (self._currentTool === "brush" || self._currentTool === "highlighter")) {
                self._finishBrushStroke(self._lastX, self._lastY);
            }
            self._drawing = false;
        };
        canvas.onpointerleave = cancelAll;
        canvas.onpointercancel = cancelAll;
    }

    _drawBrush(x1, y1, x2, y2) {
        const canvas = this.getCurrentCanvas();
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2;

        if (this._currentTool === "highlighter") {
            // 荧光笔：累积路径，不逐段描边（避免半透明重叠）
            if (!this._hlPath) {
                this._hlPath = new Path2D();
                this._hlPath.moveTo(this._lastMidX, this._lastMidY);
            }
            this._hlPath.quadraticCurveTo(x1, y1, midX, midY);
            // 绘制临时预览（用上一帧的快照 + 当前路径）
            if (!this._hlSnap) this._hlSnap = document.createElement("canvas");
            this._hlSnap.width = canvas.width;
            this._hlSnap.height = canvas.height;
            this._hlSnap.getContext("2d").drawImage(canvas, 0, 0);
        } else {
            ctx.globalAlpha = this._currentOpacity;
            ctx.strokeStyle = this._brushColor;
            ctx.lineWidth = this._currentSize;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.beginPath();
            ctx.moveTo(this._lastMidX, this._lastMidY);
            ctx.quadraticCurveTo(x1, y1, midX, midY);
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
        this._lastMidX = midX;
        this._lastMidY = midY;
    }

    _finishBrushStroke(x, y) {
        const canvas = this.getCurrentCanvas();
        if (!canvas) return;
        const ctx = canvas.getContext("2d");

        if (this._currentTool === "highlighter" && this._hlPath) {
            // 恢复画笔按下前的快照，再一次性描边整条路径
            if (this._hlSnap) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(this._hlSnap, 0, 0);
            }
            this._hlPath.quadraticCurveTo(this._lastX, this._lastY, x, y);
            ctx.globalAlpha = this._currentOpacity;
            ctx.strokeStyle = this._brushColor;
            ctx.lineWidth = this._currentSize;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.stroke(this._hlPath);
            ctx.globalAlpha = 1;
            this._hlPath = null;
            this._hlSnap = null;
            return;
        }

        ctx.globalAlpha = this._currentOpacity;
        ctx.strokeStyle = this._brushColor;
        ctx.lineWidth = this._currentSize;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(this._lastMidX, this._lastMidY);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.globalAlpha = 1;
    }

    _drawEraser(x, y) {
        const canvas = this.getCurrentCanvas();
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath();
        ctx.arc(x, y, this._brushSize * 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    getCurrentCanvas() {
        return this._currentLayerId ? this._canvases[this._currentLayerId] : null;
    }

    clearLayer(layerId) {
        const canvas = this._canvases[layerId];
        if (canvas) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
        this.clearHistory();
    }

    destroy() {
        this.clearSelection();
        this._removeSelectionRect();
        Object.values(this._canvases).forEach(c => { if (c.parentNode) c.parentNode.removeChild(c); });
        this._canvases = {};
    }
}

// ==================== Storage ====================
// 跨平台存储：桌面端用 fs 写文件，移动端用 localStorage
class Storage {
    constructor(workspacePath) {
        if (IS_DESKTOP) {
            this._basePath = workspacePath + "/data/plugins/document-drawing/drawings";
            if (!fs.existsSync(this._basePath)) {
                try { fs.mkdirSync(this._basePath, { recursive: true }); } catch (e) {}
            }
        }
        // 移动端不需要 basePath，直接用 localStorage
    }

    // 查找文档目录（优先 docId 后缀匹配，回退标题匹配，不创建）
    _findDocDir(docId, docTitle) {
        if (!IS_DESKTOP) return docId;
        var oldDir = this._basePath + "/" + docId;
        if (fs.existsSync(oldDir)) return oldDir;
        try {
            var files = fs.readdirSync(this._basePath);
            // 策略 1：匹配 docId 后 12 位后缀（避免同日文档 8 位碰撞）
            var idSuffix = docId.length >= 12 ? docId.slice(-12) : docId;
            for (var i = 0; i < files.length; i++) {
                var full = this._basePath + "/" + files[i];
                if (files[i].slice(-idSuffix.length) === idSuffix && fs.statSync(full).isDirectory()) {
                    return full;
                }
            }
            // 策略 2：匹配 _docId 或 _docTitle（处理 UUID 跨会话变化）
            if (docTitle) {
                var safeTitle = docTitle.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 60);
                for (var j = 0; j < files.length; j++) {
                    var full2 = this._basePath + "/" + files[j];
                    if (!fs.statSync(full2).isDirectory()) continue;
                    // 目录名以标题开头（处理改名和 UUID 变化）
                    if (files[j].indexOf(safeTitle) === 0) {
                        // 验证 config 里的 _docTitle 匹配
                        try {
                            var cfgPath2 = full2 + "/config.json";
                            if (fs.existsSync(cfgPath2)) {
                                var cfg2 = JSON.parse(fs.readFileSync(cfgPath2, "utf-8"));
                                if (cfg2 && cfg2._docTitle === docTitle) return full2;
                            }
                        } catch (e) {}
                    }
                }
                // 策略 3：扫描所有 config 匹配 _docTitle
                for (var k = 0; k < files.length; k++) {
                    var full3 = this._basePath + "/" + files[k];
                    if (!fs.statSync(full3).isDirectory()) continue;
                    try {
                        var cfgPath3 = full3 + "/config.json";
                        if (fs.existsSync(cfgPath3)) {
                            var cfg3 = JSON.parse(fs.readFileSync(cfgPath3, "utf-8"));
                            if (cfg3 && cfg3._docTitle === docTitle) return full3;
                        }
                    } catch (e) {}
                }
            }
        } catch (e) {}
        return oldDir;
    }

    // 创建文档目录（标题 + 完整 root_id 后 12 位，避免同一天创建的文档碰撞）
    _createDocDir(docId, title) {
        var safeTitle = (title || docId).replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 50);
        // 取 root_id 后 12 位（含 - 和 7 位随机字符），确保唯一性
        var idSuffix = docId.length >= 12 ? docId.slice(-12) : docId;
        var newDir = this._basePath + "/" + safeTitle + "_" + idSuffix;
        if (!fs.existsSync(newDir)) {
            try { fs.mkdirSync(newDir, { recursive: true }); } catch (e) {}
        }
        return newDir;
    }

    save(docId, config, layers) {
        if (IS_DESKTOP) {
            return this._saveDesktop(docId, config, layers);
        } else {
            return this._saveMobile(docId, config, layers);
        }
    }

    load(docId, callback) {
        if (IS_DESKTOP) {
            this._loadDesktop(docId, callback);
        } else {
            this._loadMobile(docId, callback);
        }
    }

    loadLayerImage(docId, layerId, callback) {
        if (IS_DESKTOP) {
            this._loadLayerImageDesktop(docId, layerId, callback);
        } else {
            this._loadLayerImageMobile(docId, layerId, callback);
        }
    }

    deleteLayerImage(docId, layerId) {
        if (IS_DESKTOP) {
            var dir = this._findDocDir(docId);
            var candidates = [];
            try {
                var cfgPath = dir + "/config.json";
                if (fs.existsSync(cfgPath)) {
                    var cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
                    if (cfg && cfg.layers) {
                        var layer = cfg.layers.find(function (l) { return l.id === layerId; });
                        if (layer && layer.file) candidates.push(layer.file);
                    }
                }
            } catch (e) {}
            candidates.push("layer" + layerId + ".png");
            candidates.forEach(function (f) {
                var fp = dir + "/" + f;
                if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (e) {} }
            });
        } else {
            try { localStorage.removeItem(LS_IMG_PREFIX + docId + "_" + layerId); } catch (e) {}
        }
    }

    // ========== 桌面端实现（Node.js fs） ==========
    _saveDesktop(docId, config, layers) {
        config._docId = docId;  // ★ 确保 config 始终写入正确的 _docId
        // ★ 先找已有目录（按标题匹配，处理 UUID 跨会话变化），找不到再新建
        var existingDir = this._findDocDir(docId, config._docTitle);
        var dir;
        if (existingDir !== (this._basePath + "/" + docId) || fs.existsSync(existingDir)) {
            dir = existingDir;  // 找到了已有目录
        } else {
            dir = this._createDocDir(docId, config._docTitle || "");
        }
        try { fs.writeFileSync(dir + "/config.json", JSON.stringify(config, null, 2), "utf-8"); } catch (e) { return false; }
        if (layers) {
            // 收集当前图层 file 引用
            var validFiles = {};
            layers.forEach(function (l) {
                var lf = l.file || ((l.name || ("图层" + l.id)).replace(/[\\/:*?"<>|]/g, "_").slice(0, 50) + "_" + l.id + ".png");
                validFiles[lf] = true;
            });
            // 清理已删除图层的残留文件
            try {
                var files = fs.readdirSync(dir);
                files.forEach(function (f) {
                    if (/\.png$/.test(f) && f !== "config.json" && !validFiles[f]) {
                        try { fs.unlinkSync(dir + "/" + f); } catch (e) {}
                    }
                });
            } catch (e) {}
            // 保存当前图层
            layers.forEach(layer => {
                if (layer.canvas) {
                    try {
                        // 用图层名命名图片文件
                        var lName = (layer.name || ("图层" + layer.id)).replace(/[\\/:*?"<>|]/g, "_").slice(0, 50);
                        var lFile = lName + "_" + layer.id + ".png";
                        const dataUrl = layer.canvas.toDataURL("image/png");
                        const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
                        fs.writeFileSync(dir + "/" + lFile, Buffer.from(base64, "base64"));
                        // 更新 layer.file 引用
                        layer.file = lFile;
                    } catch (e) {}
                }
            });
        }
        return true;
    }

    _loadDesktop(docId, callback) {
        var dir = this._findDocDir(docId);
        var cfgPath = dir + "/config.json";
        // 后缀匹配失败 → 扫描所有目录按 _docId 匹配
        if (!fs.existsSync(cfgPath)) {
            try {
                var files = fs.readdirSync(this._basePath);
                for (var i = 0; i < files.length; i++) {
                    var f = this._basePath + "/" + files[i] + "/config.json";
                    if (fs.existsSync(f)) {
                        try {
                            var c = JSON.parse(fs.readFileSync(f, "utf-8"));
                            if (c && c._docId === docId) {
                                callback(c); return;
                            }
                        } catch (e) {}
                    }
                }
            } catch (e) {}
            callback(null); return;
        }
        try { callback(JSON.parse(fs.readFileSync(cfgPath, "utf-8"))); } catch (e) { callback(null); }
    }

    _loadLayerImageDesktop(docId, layerId, callback) {
        // 复用 _loadDesktop 的查找逻辑：先后缀匹配，再扫描所有 config 按 _docId 匹配
        var dir = this._findDocDir(docId);
        var cfgPath = dir + "/config.json";
        if (!fs.existsSync(cfgPath)) {
            // 扫描所有目录找匹配 _docId 的 config
            try {
                var files = fs.readdirSync(this._basePath);
                for (var i = 0; i < files.length; i++) {
                    var f = this._basePath + "/" + files[i] + "/config.json";
                    if (fs.existsSync(f)) {
                        try {
                            var c = JSON.parse(fs.readFileSync(f, "utf-8"));
                            if (c && c._docId === docId) {
                                dir = this._basePath + "/" + files[i];
                                cfgPath = f;
                                break;
                            }
                        } catch (e) {}
                    }
                }
            } catch (e) {}
        }
        if (!fs.existsSync(cfgPath)) { callback(null); return; }
        var layer = null;
        try {
            var cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
            if (cfg && cfg.layers) {
                layer = cfg.layers.find(function (l) { return l.id === layerId; });
            }
        } catch (e) {}
        var fileName = (layer && layer.file) ? layer.file : ("layer" + layerId + ".png");
        var filePath = dir + "/" + fileName;
        if (!fs.existsSync(filePath)) filePath = dir + "/layer" + layerId + ".png";
        if (!fs.existsSync(filePath)) { callback(null); return; }
        const img = new Image();
        img.onload = function () { callback(img); };
        img.onerror = function () { callback(null); };
        img.src = "file:///" + filePath.replace(/\\/g, "/");
    }

    // ========== 移动端实现（localStorage） ==========
    _saveMobile(docId, config, layers) {
        try {
            // 保存配置 JSON
            localStorage.setItem(LS_PREFIX + docId, JSON.stringify(config));
            // 保存图层图片为 base64
            if (layers) {
                layers.forEach(layer => {
                    if (layer.canvas) {
                        try {
                            const dataUrl = layer.canvas.toDataURL("image/png");
                            localStorage.setItem(LS_IMG_PREFIX + docId + "_" + layer.id, dataUrl);
                        } catch (e) {
                            console.warn("[DocumentDrawing] save layer image failed (可能超出存储限制):", e.message);
                        }
                    }
                });
            }
            return true;
        } catch (e) {
            console.warn("[DocumentDrawing] save failed:", e.message);
            return false;
        }
    }

    _loadMobile(docId, callback) {
        try {
            const raw = localStorage.getItem(LS_PREFIX + docId);
            if (!raw) { callback(null); return; }
            callback(JSON.parse(raw));
        } catch (e) { callback(null); }
    }

    _loadLayerImageMobile(docId, layerId, callback) {
        try {
            const dataUrl = localStorage.getItem(LS_IMG_PREFIX + docId + "_" + layerId);
            if (!dataUrl) { callback(null); return; }
            const img = new Image();
            img.onload = function () { callback(img); };
            img.onerror = function () { callback(null); };
            img.src = dataUrl;
        } catch (e) { callback(null); }
    }

    // ========== 全局扫描：列出所有文档及其图层 ==========
    listAllDocuments(callback) {
        if (IS_DESKTOP) {
            this._listAllDesktop(callback);
        } else {
            this._listAllMobile(callback);
        }
    }

    _listAllDesktop(callback) {
        var result = [];
        if (!fs.existsSync(this._basePath)) { callback(result); return; }
        var self = this;
        try {
            var dirs = fs.readdirSync(this._basePath);
            dirs.forEach(function (dirName) {
                var fullDir = self._basePath + "/" + dirName;
                try {
                    if (!fs.statSync(fullDir).isDirectory()) return;
                    var cfgPath = fullDir + "/config.json";
                    if (!fs.existsSync(cfgPath)) return;
                    var cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
                    if (!cfg) return;
                    var docId = cfg._docId || "";
                    if (!docId) {
                        var lastUnderscore = dirName.lastIndexOf("_");
                        if (lastUnderscore >= 0 && lastUnderscore < dirName.length - 1) {
                            var suffix = dirName.slice(lastUnderscore + 1);
                            if (/^[a-zA-Z0-9]{8}$/.test(suffix)) docId = suffix;
                            else docId = dirName;
                        } else docId = dirName;
                    }
                    var docTitle = cfg._docTitle || dirName;
                    var layers = (cfg.layers || []).map(function (l) {
                        return { id: l.id, name: l.name || ("图层 " + l.id), visible: l.visible !== false, file: l.file || "" };
                    });
                    result.push({ docId: docId, docTitle: docTitle, dirName: dirName, layers: layers });
                } catch (e) {}
            });
        } catch (e) {}
        callback(result);
    }

    _listAllMobile(callback) {
        var result = [];
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var key = localStorage.key(i);
                if (key && key.indexOf(LS_PREFIX) === 0) {
                    try {
                        var docId = key.slice(LS_PREFIX.length);
                        var cfg = JSON.parse(localStorage.getItem(key));
                        if (!cfg) continue;
                        var docTitle = cfg._docTitle || docId;
                        var layers = (cfg.layers || []).map(function (l) {
                            return { id: l.id, name: l.name || ("图层 " + l.id), visible: l.visible !== false, file: l.file || "" };
                        });
                        result.push({ docId: docId, docTitle: docTitle, dirName: docId, layers: layers });
                    } catch (e) {}
                }
            }
        } catch (e) {}
        callback(result);
    }

    // 将 config.json 中的 _docId 从 uuid 更新为 root_id
    updateDocId(uuid, rootId, callback) {
        if (IS_DESKTOP) {
            var dir = this._findDocDir(uuid);
            var cfgPath = dir + "/config.json";
            try {
                if (fs.existsSync(cfgPath)) {
                    var cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
                    if (cfg && cfg._docId === uuid) {
                        cfg._docId = rootId;
                        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");
                        callback(true);
                        return;
                    }
                }
            } catch (e) {}
            callback(false);
        } else {
            try {
                var raw = localStorage.getItem(LS_PREFIX + uuid);
                if (raw) {
                    var cfg2 = JSON.parse(raw);
                    cfg2._docId = rootId;
                    localStorage.setItem(LS_PREFIX + uuid, JSON.stringify(cfg2));
                    // 同时写入 rootId key，下次直接查找
                    localStorage.setItem(LS_PREFIX + rootId, JSON.stringify(cfg2));
                    callback(true);
                    return;
                }
            } catch (e) {}
            callback(false);
        }
    }
}

// ==================== ExportManager ====================
class ExportManager {
    constructor(canvasManager, layerManager, docManager, pluginDir) {
        this._canvasManager = canvasManager;
        this._layerManager = layerManager;
        this._docManager = docManager;
        this._pluginDir = pluginDir;
        this._exportPath = "";  // 用户自定义导出目录
    }

    setExportPath(p) { this._exportPath = p || ""; }

    _getExportDir() {
        return this._exportPath || (this._pluginDir + "/exports");
    }

    _ensureHtml2Canvas(callback) {
        if (this._html2canvas) { callback(this._html2canvas); return; }
        const self = this;
        const script = document.createElement("script");
        // 跨平台路径：桌面端用 file:// 路径，移动端用相对路径
        if (IS_DESKTOP) {
            script.src = this._pluginDir + "/html2canvas.min.js";
        } else {
            script.src = "/plugins/document-drawing/html2canvas.min.js";
        }
        script.onload = function () {
            self._html2canvas = window.html2canvas;
            self._html2canvasReady = true;
            callback(self._html2canvas);
        };
        script.onerror = function () {
            console.error("[DocumentDrawing] html2canvas load failed");
            callback(null);
        };
        document.head.appendChild(script);
    }

    exportPNG(selectedIds) {
        var that = this;
        var docId = this._docManager ? this._docManager.getDocumentID() : "export";

        // 合并选中图层
        var layers = that._layerManager.getLayers();
        var sel = layers.filter(function (l) {
            return l.visible && l.canvas && (!selectedIds || selectedIds.indexOf(l.id) >= 0);
        });
        if (sel.length === 0) { siyuan.showMessage("⚠️ 没有可见图层", 2000); return; }
        var mc = document.createElement("canvas");
        mc.width = sel[0].canvas.width;
        mc.height = sel[0].canvas.height;
        var mctx = mc.getContext("2d");
        mctx.fillStyle = "#ffffff";
        mctx.fillRect(0, 0, mc.width, mc.height);
        sel.forEach(function (l) { mctx.drawImage(l.canvas, 0, 0); });

        // 尝试截文档背景（桌面端和平板端都走 html2canvas）
        var editor = this._docManager ? this._docManager.getDocumentDOM() : null;
        if (editor && this._html2canvasReady !== false) {
            this._ensureHtml2Canvas(function (h2c) {
                if (h2c) {
                    h2c(editor, { backgroundColor: "#ffffff", scale: 3, useCORS: true, logging: false }).then(function (docCanvas) {
                        var finalCanvas = document.createElement("canvas");
                        finalCanvas.width = docCanvas.width;
                        finalCanvas.height = docCanvas.height;
                        var fctx = finalCanvas.getContext("2d");
                        fctx.drawImage(docCanvas, 0, 0);
                        var scaleX = docCanvas.width / mc.width;
                        var scaleY = docCanvas.height / mc.height;
                        fctx.save();
                        fctx.scale(scaleX, scaleY);
                        sel.forEach(function (l) { fctx.drawImage(l.canvas, 0, 0); });
                        fctx.restore();
                        that._finishExport(finalCanvas, docId);
                    }).catch(function () { that._finishExport(mc, docId); });
                } else {
                    that._finishExport(mc, docId);
                }
            });
        } else {
            this._finishExport(mc, docId);
        }
    }

    _finishExport(canvas, docId) {
        var selfExport = this;
        var maxDim = 2800;
        if (canvas.width > maxDim || canvas.height > maxDim) {
            var scale = Math.min(maxDim / canvas.width, maxDim / canvas.height);
            var sc = document.createElement("canvas");
            sc.width = Math.round(canvas.width * scale);
            sc.height = Math.round(canvas.height * scale);
            sc.getContext("2d").drawImage(canvas, 0, 0, sc.width, sc.height);
            canvas = sc;
        }
        var dataUrl = canvas.toDataURL("image/png");
        var docTitle = "";
        try { docTitle = this._docManager ? this._docManager.getDocumentTitle() : ""; } catch (e) {}
        if (!docTitle) docTitle = docId;
        docTitle = docTitle.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 80);
        var ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        var fn = docTitle + "_" + ts + ".png";

        // ★ 平板端：用 fetchPost 上传到思源本地服务器获取链接
        if (!IS_DESKTOP && typeof _siyuanFetchPost === "function") {
            try {
                var blobBin = atob(dataUrl.split(",")[1]);
                var blobArr = new Uint8Array(blobBin.length);
                for (var bi = 0; bi < blobBin.length; bi++) blobArr[bi] = blobBin.charCodeAt(bi);
                var blob = new Blob([blobArr], { type: "image/png" });
                var formData = new FormData();
                formData.append("file", blob, fn);
                formData.append("type", "image/png");
                _siyuanFetchPost("/api/export/exportAsFile", formData, function (resp) {
                    if (resp && resp.data && typeof resp.data === "object" && resp.data.file) {
                        _showPreview(resp.data.file);
                    } else if (resp && typeof resp.data === "string" && resp.data.length > 5) {
                        _showPreview(resp.data);
                    } else {
                        _showPreview(null);
                    }
                });
                return;
            } catch (e) { /* 回退 */ }
        }

        // 桌面端：预览弹窗 + 点击保存才写入文件
        if (IS_DESKTOP && fs) {
            _showPreview(null);
            return;
        }

        // dataUrl 直接通过 a 标签打开
        try {
            var a2 = document.createElement("a");
            a2.href = dataUrl; a2.target = "_blank"; a2.rel = "noopener";
            document.body.appendChild(a2); a2.click();
            setTimeout(function () { document.body.removeChild(a2); }, 1000);
                        return;
        } catch (e) {}

        // 最终回退：预览弹窗
        _showPreview(null);

        function _showPreview(serverUrl) {
            if (window._ddExportMsgId) { try { siyuan.hideMessage(window._ddExportMsgId); } catch(e) {} window._ddExportMsgId = null; }
            var overlay = document.createElement("div");
            overlay.style.cssText = "position:fixed;z-index:10010;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;";
            var buttonsHtml;
            if (serverUrl) {
                buttonsHtml = '<button id="dd-pv-link" style="margin-top:10px;padding:8px 20px;background:#1890ff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">🌐 在浏览器中查看</button>';
            } else if (IS_DESKTOP) {
                buttonsHtml = '<button id="dd-pv-save" style="margin-top:10px;padding:8px 20px;background:#1890ff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">💾 保存到本地</button>';
            } else {
                buttonsHtml = '<div style="margin-top:8px;display:flex;gap:8px;">' +
                  '<button id="dd-pv-save" style="padding:7px 14px;background:#1890ff;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:13px;">💾 保存</button>' +
                  '<button id="dd-pv-browser" style="padding:7px 14px;background:#52c41a;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:13px;">🌐 浏览器打开</button>' +
                  '</div>';
            }
            overlay.innerHTML =
                '<div style="background:#fff;border-radius:10px;padding:14px;max-width:92vw;max-height:90vh;display:flex;flex-direction:column;align-items:center;box-shadow:0 8px 32px rgba(0,0,0,0.3);overflow-y:auto;">' +
                '<div style="font-size:14px;font-weight:600;margin-bottom:8px;">导出预览</div>' +
                '<img id="dd-pv-img" style="max-width:88vw;max-height:50vh;border-radius:4px;object-fit:contain;">' +
                '<div style="margin-top:6px;font-size:11px;color:#999;">' + fn + '</div>' +
                buttonsHtml +
                '<button id="dd-pv-close" style="margin-top:8px;padding:7px 18px;background:#eee;border:1px solid #ddd;border-radius:5px;cursor:pointer;font-size:13px;">关闭</button>' +
                '</div>';
            document.body.appendChild(overlay);
            // 大图 dataUrl 直接设 src 比拼进 innerHTML 更可靠
            overlay.querySelector("#dd-pv-img").src = dataUrl;

            if (serverUrl) {
                overlay.querySelector("#dd-pv-link").onclick = function () {
                    var a = document.createElement("a");
                    a.href = serverUrl; a.target = "_blank"; a.rel = "noopener";
                    document.body.appendChild(a); a.click();
                    setTimeout(function () { document.body.removeChild(a); }, 1000);
                };
            } else if (IS_DESKTOP) {
                overlay.querySelector("#dd-pv-save").onclick = function () {
                    try {
                        var exportDir = selfExport._getExportDir();
                        if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
                        var b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
                        fs.writeFileSync(exportDir + "/" + fn, Buffer.from(b64, "base64"));
                        siyuan.showMessage("✅ 已保存 → " + exportDir + "/" + fn, 4000);
                    } catch (e) {
                        siyuan.showMessage("❌ 保存失败：" + (e.message || ""), 4000);
                    }
                };
            } else {
                overlay.querySelector("#dd-pv-save").onclick = function () {
                    var a = document.createElement("a");
                    a.href = dataUrl; a.download = fn; a.style.display = "none";
                    document.body.appendChild(a); a.click();
                    setTimeout(function () { document.body.removeChild(a); }, 1000);
                };
                overlay.querySelector("#dd-pv-browser").onclick = function () {
                    var a = document.createElement("a");
                    a.href = dataUrl; a.target = "_blank"; a.rel = "noopener";
                    document.body.appendChild(a); a.click();
                    setTimeout(function () { document.body.removeChild(a); }, 1000);
                };
            }
            overlay.querySelector("#dd-pv-close").onclick = function () { overlay.remove(); };
            overlay.addEventListener("click", function (ev) { if (ev.target === overlay) overlay.remove(); });
                    }
    }

    _mergeAndSave(docCanvas, docId, selectedIds) {
        const layers = this._layerManager.getLayers();
        const visibleLayers = layers.filter(function (l) {
            return l.visible && l.canvas && (!selectedIds || selectedIds.indexOf(l.id) >= 0);
        });

        const mergeCanvas = document.createElement("canvas");
        mergeCanvas.width = docCanvas.width;
        mergeCanvas.height = docCanvas.height;
        const ctx = mergeCanvas.getContext("2d");

        ctx.drawImage(docCanvas, 0, 0);

        const firstCanvas = visibleLayers.length > 0 ? visibleLayers[0].canvas : null;
        if (firstCanvas) {
            const scaleX = docCanvas.width / firstCanvas.width;
            const scaleY = docCanvas.height / firstCanvas.height;
            ctx.save();
            ctx.scale(scaleX, scaleY);
            visibleLayers.forEach(layer => { ctx.drawImage(layer.canvas, 0, 0); });
            ctx.restore();
        }

        this._saveCanvas(mergeCanvas, docId);
    }

    _exportDrawingOnly(docId, selectedIds) {
        const layers = this._layerManager.getLayers();
        const visibleLayers = layers.filter(function (l) {
            return l.visible && l.canvas && (!selectedIds || selectedIds.indexOf(l.id) >= 0);
        });
        if (visibleLayers.length === 0) {
            siyuan.showMessage("⚠️ 没有可见图层可导出", 2000);
            return;
        }
        const firstCanvas = visibleLayers[0].canvas;
        const mergeCanvas = document.createElement("canvas");
        mergeCanvas.width = firstCanvas.width;
        mergeCanvas.height = firstCanvas.height;
        const ctx = mergeCanvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, mergeCanvas.width, mergeCanvas.height);
        visibleLayers.forEach(layer => { ctx.drawImage(layer.canvas, 0, 0); });
        this._saveCanvas(mergeCanvas, docId);
    }

    _saveCanvas(canvas, docId) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const fileName = "drawing-" + docId + "-" + timestamp + ".png";

        if (IS_DESKTOP) {
            // 桌面端：写文件到导出目录
            const exportDir = this._getExportDir();
            try {
                if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
                const outPath = exportDir + "/" + fileName;
                const pngData = canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
                fs.writeFileSync(outPath, Buffer.from(pngData, "base64"));
                siyuan.showMessage("✅ 已保存：" + outPath, 4000);
                console.log("[DocumentDrawing] exported to", outPath);
            } catch (e) {
                siyuan.showMessage("❌ 导出失败：" + e.message, 4000);
            }
        } else {
            // 移动端：缩小后导出（避免大画布 toDataURL 内存溢出）
            try {
                var maxDim = 2800;
                var w = canvas.width, h = canvas.height;
                var exportCanvas = canvas;
                if (w > maxDim || h > maxDim) {
                    var scale = Math.min(maxDim / w, maxDim / h);
                    exportCanvas = document.createElement("canvas");
                    exportCanvas.width = Math.round(w * scale);
                    exportCanvas.height = Math.round(h * scale);
                    exportCanvas.getContext("2d").drawImage(canvas, 0, 0, exportCanvas.width, exportCanvas.height);
                }
                var dataUrl = exportCanvas.toDataURL("image/png");
                var a = document.createElement("a");
                a.href = dataUrl;
                a.download = fileName;
                a.style.display = "none";
                document.body.appendChild(a);
                a.click();
                setTimeout(function () { document.body.removeChild(a); }, 1000);
                siyuan.showMessage("✅ 已保存到下载目录 → " + fileName, 5000);
            } catch (e) {
                siyuan.showMessage("❌ 导出失败：" + (e.message || "未知错误"), 4000);
            }
        }
    }
}

// ==================== 主插件类 ====================
class DocumentDrawingPlugin extends siyuan.Plugin {
    onload() {
        const self = this;
        this._overlayContainer = null;
        this._toolbarEl = null;
        this._menuEl = null;
        this._layerDialog = null;  // 图层管理对话框引用
        this._userClosedToolbar = false;  // 用户是否手动关了工具栏
        this._pluginDir = this.dataDir ? this.dataDir.replace(/\/$/, "") : "D:/思源笔记/Cherise WorkPlace/data/plugins/document-drawing";
        this._workspacePath = this.dataDir ? this.dataDir.replace(/\/data\/plugins\/.*$/, "") : "D:/思源笔记/Cherise WorkPlace";

        this._loadCSS();

        this.addTopBar({
            icon: "iconEdit",
            title: "文档绘图",
            position: "right",
            callback: function (e) { self.toggleMenu(e); }
        });

        this.addCommand({
            langKey: "open-drawing",
            langText: "打开绘图面板",
            hotkey: "⇧⌘D",
            customHotkey: "Ctrl+Shift+D",
            callback: function () { self.toggleDrawing(); }
        });

        console.log("[DocumentDrawing] loaded");
    }

    // ========== 自动保存 ==========
    _autoSave() {
        if (!this._storage || !this._layerManager || !this._docManager) return;
        try {
            const docId = this._docManager.getDocumentID();
            // ★ 只保存有效的 root_id，UUID 阶段不保存
            if (!docId || !/^\d{14}-[a-z0-9]{7}$/.test(docId)) return;
            var cfg = this._layerManager.toConfig();
            cfg._docTitle = this._docManager.getDocumentTitle() || docId;
            cfg._docId = docId;
            this._storage.save(docId, cfg, this._layerManager.getLayers());
            console.log("[DocumentDrawing] auto-saved", docId);
        } catch (e) { console.warn("[DocumentDrawing] auto-save failed:", e.message); }
    }

    onunload() {
        // ★ 退出时无论如何都要保存（即使 root_id 未就绪，用标题兜底）
        if (!this._storage || !this._layerManager || !this._docManager) return;
        try {
            var docId = this._docManager.getDocumentID();
            var docTitle = this._docManager.getDocumentTitle() || "";
            // 没有有效 root_id → 用标题生成临时 ID 保存
            if (!docId || !/^\d{14}-[a-z0-9]{7}$/.test(docId)) {
                docId = "_exit_" + docTitle.replace(/[^a-zA-Z0-9一-鿿]/g, "_").slice(0, 40);
                if (!docId || docId === "_exit_") docId = "_exit_unknown";
                console.log("[DocumentDrawing] exit-save with fallback ID:", docId);
            }
            var cfg = this._layerManager.toConfig();
            cfg._docTitle = docTitle;
            cfg._docId = docId;
            // 只有有图层内容才保存
            if (this._layerManager.getLayers().length > 0) {
                this._storage.save(docId, cfg, this._layerManager.getLayers());
                console.log("[DocumentDrawing] exit-saved", docId);
            }
        } catch (e) { console.warn("[DocumentDrawing] exit-save failed:", e.message); }
        this._removeOverlay();
        this._removeToolbar();
        this.closeMenu();
        if (this._canvasManager) this._canvasManager.destroy();
        if (this._docManager && this._docManager.stopWatch) this._docManager.stopWatch();
        if (this._keydownHandler) {
            document.removeEventListener("keydown", this._keydownHandler, true);
            this._keydownHandler = null;
        }
        console.log("[DocumentDrawing] unloaded");
    }

    _loadCSS() {
        try {
            const cssPath = this._pluginDir + "/index.css";
            if (IS_DESKTOP && fs && fs.existsSync(cssPath)) {
                const css = fs.readFileSync(cssPath, "utf-8");
                let styleEl = document.getElementById("document-drawing-style");
                if (!styleEl) { styleEl = document.createElement("style"); styleEl.id = "document-drawing-style"; document.head.appendChild(styleEl); }
                styleEl.textContent = css;
            } else {
                // 移动端：通过 link 标签加载插件目录下的 CSS
                let linkEl = document.getElementById("document-drawing-style");
                if (!linkEl) {
                    linkEl = document.createElement("link");
                    linkEl.id = "document-drawing-style";
                    linkEl.rel = "stylesheet";
                    // 思源移动端插件静态文件通过 /plugins/ 路径访问
                    linkEl.href = "/plugins/document-drawing/index.css";
                    document.head.appendChild(linkEl);
                }
            }
        } catch (e) { console.warn("[DocumentDrawing] CSS load failed:", e.message); }
    }

    // ========== 下拉菜单 ==========
    toggleMenu(e) {
        if (this._menuEl && document.body.contains(this._menuEl)) { this.closeMenu(); return; }
        this.showMenu(e);
    }

    showMenu(e) {
        this.closeMenu();
        const self = this;

        const menu = document.createElement("div");
        menu.className = "drawing-popup-menu";
        menu.style.cssText = "position:fixed;z-index:9999;background:var(--b3-menu-background,#fff);" +
            "border:1px solid var(--b3-border-color,#e0e0e0);border-radius:8px;" +
            "box-shadow:0 4px 16px rgba(0,0,0,0.12);padding:4px 0;min-width:180px;";

        const items = [
            { icon: "✏️", label: "添加图层", action: "add-layer" },
            { icon: "📂", label: "查看 / 管理图层", action: "show-layers" },
            { icon: "🗂️", label: "查看所有图层", action: "show-all-layers" },
            { icon: "💾", label: "导出", action: "export" },
            { type: "separator" },
            { icon: "⚙️", label: "设置", action: "settings" }
        ];

        items.forEach(function (item) {
            if (item.type === "separator") {
                const sep = document.createElement("div");
                sep.style.cssText = "height:1px;background:var(--b3-border-color,#e0e0e0);margin:4px 0;";
                menu.appendChild(sep);
                return;
            }
            const row = document.createElement("div");
            row.style.cssText = "padding:8px 16px;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:8px;transition:background 0.1s;";
            row.innerHTML = "<span>" + item.icon + "</span><span>" + item.label + "</span>";
            row.onmouseenter = function () { this.style.background = "var(--b3-list-hover, rgba(0,0,0,0.06))"; };
            row.onmouseleave = function () { this.style.background = ""; };
            row.onclick = function (ev) { ev.stopPropagation(); self.closeMenu(); self._handleMenuAction(item.action); };
            menu.appendChild(row);
        });

        document.body.appendChild(menu);
        this._menuEl = menu;

        // 定位菜单：e 是 MouseEvent，e.currentTarget 是按钮元素
        var btn = (e && e.currentTarget) || (e && e.target) || null;
        if (btn && btn.getBoundingClientRect) {
            const rect = btn.getBoundingClientRect();
            menu.style.left = Math.max(0, rect.left - 60) + "px";
            menu.style.top = (rect.bottom + 8) + "px";
        } else {
            // fallback：靠右上角
            menu.style.right = "60px";
            menu.style.top = "60px";
        }

        setTimeout(function () {
            const handler = function (ev) {
                if (menu && !menu.contains(ev.target)) {
                    self.closeMenu();
                    document.removeEventListener("click", handler, true);
                }
            };
            document.addEventListener("click", handler, true);
        }, 100);
    }

    closeMenu() {
        if (this._menuEl && document.body.contains(this._menuEl)) {
            try { document.body.removeChild(this._menuEl); } catch (e) {}
        }
        this._menuEl = null;
    }

    _handleMenuAction(action) {
        const self = this;
        if (!this._layerManager) this._initManagers();

        switch (action) {
            case "add-layer":
                this._addLayerAndShow();
                break;
            case "show-layers":
                this._showLayerListDialog();
                break;
            case "show-all-layers":
                this._showAllLayersDialog();
                break;
            case "export":
                this._showExportDialog();
                break;
            case "settings":
                this._openSettings();
                break;
        }
    }

    // ========== 核心：添加图层 + 显示覆盖画布 + 工具条 ==========
    _initManagers() {
        if (this._layerManager) return;
        try {
            this._docManager = new DocumentManager();
            // ★ 注入 root_id 解析器并启动监听（确保 detect 时 resolver 已就绪）
            var self0 = this;
            this._docManager.init(function (uuid, title, cb) {
                self0._resolveUuidToRootId(uuid, title, cb);
            });
            this._layerManager = new LayerManager();
            this._canvasManager = new CanvasManager();
            this._storage = new Storage(this._workspacePath);
            this._exportManager = new ExportManager(this._canvasManager, this._layerManager, this._docManager, this._pluginDir);

            // 加载用户设置并应用到画笔
            this._applySettings(this._loadSettings());

            // 笔双击切换工具时同步更新工具栏按钮高亮
            const self2 = this;
            this._canvasManager.onToolChange(function (newTool) {
                if (self2._toolbarEl && document.body.contains(self2._toolbarEl)) {
                    // 按钮高亮
                    self2._toolbarEl.querySelectorAll(".drawing-tool-btn").forEach(function (b) {
                        b.style.background = "transparent";
                        b.style.border = "2px solid transparent";
                        b.classList.remove("active");
                    });
                    const activeBtn = self2._toolbarEl.querySelector('[data-tool="' + newTool + '"]');
                    if (activeBtn) {
                        activeBtn.style.background = "#e8f0fe";
                        activeBtn.style.border = "2px solid #1890ff";
                        activeBtn.classList.add("active");
                    }
                    // 同步粗细滑块和标签
                    var tbSize = self2._toolbarEl.querySelector("#dd-size");
                    var tbSizeLabel = self2._toolbarEl.querySelector("#dd-size-label");
                    if (tbSize && self2._canvasManager._currentSize) {
                        tbSize.value = self2._canvasManager._currentSize;
                        if (tbSizeLabel) tbSizeLabel.textContent = self2._canvasManager._currentSize;
                    }
                }
            });

            // 手势通知 → 屏幕上显示提醒
            this._canvasManager.onNotify(function (msg) {
                siyuan.showMessage(msg, 1500);
            });

            const self = this;
            console.log("[DocumentDrawing] registering onDocChange callback");
            this._docManager.onDocChange(function (newDocId, oldDocId) {
                console.log("[DocumentDrawing] document changed from", oldDocId, "to", newDocId);
                // ★ 判断是否为同一文档的 ID 转换（null→root_id 或 UUID→root_id）
                var isFirstResolve = !oldDocId;
                var isUuidToRootId = oldDocId && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(oldDocId);
                var isSameDoc = isFirstResolve || isUuidToRootId;

                if (!isSameDoc) {
                    // ★ 真正的文档切换：保存旧文档 + 重置
                    if (oldDocId && self._layerManager._layers.length > 0) {
                        self._storage.save(oldDocId, self._layerManager.toConfig(), self._layerManager.getLayers());
                        console.log("[DocumentDrawing] saved old document:", oldDocId);
                    }
                    self._layerManager._layers = [];
                    self._layerManager._currentLayerId = null;
                    self._layerManager._nextId = 1;
                    self._canvasManager._canvases = {};
                    self._canvasManager._currentLayerId = null;
                    console.log("[DocumentDrawing] layer data reset");
                    if (self._layerDialog) {
                        try { self._layerDialog.destroy(); } catch (e) {}
                        self._layerDialog = null;
                    }
                    self._removeOverlay();
                    self._removeToolbar();
                } else {
                    console.log("[DocumentDrawing] same-doc transition, keep layers intact");
                }

                // 加载新文档的图层
                self._storage.load(newDocId, function (config) {
                    console.log("[DocumentDrawing] loading config for:", newDocId, config);
                    if (config && config.layers && config.layers.length > 0) {
                        if (isSameDoc && self._layerManager._layers.length > 0) {
                            console.log("[DocumentDrawing] same-doc, keeping existing layers");
                            self._layerManager.loadFromConfig(config);
                        } else {
                            self._layerManager.loadFromConfig(config);
                            // ★ 工具栏和画布同步：用户关了就不重建，开着就重建
                            if (!self._userClosedToolbar) {
                                self._rebuildOverlay(newDocId);
                            }
                        }
                    } else if (!isSameDoc) {
                        console.log("[DocumentDrawing] new document has no saved layers");
                    }
                });
            });

            const docId = this._docManager.getDocumentID();
            this._storage.load(docId, function (config) {
                if (config && config.layers) {
                    self._layerManager.loadFromConfig(config);
                    self._rebuildOverlay(docId);
                }
            });
        } catch (e) { console.error("[DocumentDrawing] _initManagers:", e); }
    }

    // 强制同步：在每次打开图层/添加图层时调用，确保图层数据属于当前文档
    // 防止轮询间隔（2秒）内文档切换未被异步检测到
    _syncDocumentLayers() {
        if (!this._docManager) return;
        // detectCurrentDocument 若发现文档变了，会同步触发 onDocChange 完成切换
        this._docManager.detectCurrentDocument();
    }

    // ========== 设置持久化 ==========
    _loadSettings() {
        const defaults = {
            brushSize: 3, brushColor: "#000000", brushOpacity: 100, autoSave: true,
            highlighterSize: 20, highlighterOpacity: 60,
            presetColors: ["#000000", "#E02020", "#FFC000", "#2060E0", "#20A020"],
            fingerDoubleTapEnabled: true,   // 手指双击切换画笔/橡皮
            twoFingerUndoEnabled: true,     // 双指点击撤销
            exportPath: ""                  // 自定义导出目录（桌面端），空=默认
        };
        try {
            if (IS_DESKTOP && fs) {
                const cfgPath = this._pluginDir + "/config.json";
                if (fs.existsSync(cfgPath)) {
                    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
                    return Object.assign(defaults, cfg);
                }
            } else {
                const raw = localStorage.getItem("dd_settings");
                if (raw) return Object.assign(defaults, JSON.parse(raw));
            }
        } catch (e) { /* ignore */ }
        return defaults;
    }

    _saveSettings(cfg) {
        try {
            if (IS_DESKTOP && fs) {
                fs.writeFileSync(this._pluginDir + "/config.json", JSON.stringify(cfg, null, 2), "utf-8");
            } else {
                localStorage.setItem("dd_settings", JSON.stringify(cfg));
            }
            return true;
        } catch (e) { return false; }
    }

    _applySettings(cfg) {
        if (!cfg || !this._canvasManager) return;
        if (cfg.brushSize !== undefined) {
            this._canvasManager.setBrushSize(parseInt(cfg.brushSize));
            this._canvasManager._currentSize = parseInt(cfg.brushSize);
        }
        if (cfg.brushColor !== undefined) this._canvasManager.setBrushColor(cfg.brushColor);
        if (cfg.brushOpacity !== undefined) {
            var op = parseInt(cfg.brushOpacity) / 100;
            this._canvasManager._currentOpacity = op;
            this._canvasManager._brushOpacity = op;
        }
        if (cfg.highlighterSize !== undefined) {
            this._canvasManager._highlighterSize = parseInt(cfg.highlighterSize);
        }
        if (cfg.highlighterOpacity !== undefined) {
            this._canvasManager._highlighterOpacity = parseInt(cfg.highlighterOpacity) / 100;
        }
        this._canvasManager.setGestureSettings(
            cfg.fingerDoubleTapEnabled !== false,
            cfg.twoFingerUndoEnabled !== false
        );
        if (this._exportManager && cfg.exportPath !== undefined) {
            this._exportManager.setExportPath(cfg.exportPath);
        }
    }

    _addLayerAndShow() {
        this._userClosedToolbar = false;
        if (!this._layerManager) this._initManagers();
        this._syncDocumentLayers();

        // ★ 用户之前关了 → 先完整重建
        if (!this._toolbarEl || !document.body.contains(this._toolbarEl)) {
            var docId = this._docManager ? this._docManager.getDocumentID() : null;
            if (docId && this._layerManager.getLayers().length > 0) {
                this._rebuildOverlay(docId);
                return;
            }
        }

        const editor = this._docManager ? this._docManager.getDocumentDOM() : null;
        if (!editor) { siyuan.showMessage("⚠️ 请先打开一个文档", 2000); return; }

        const rect = editor.getBoundingClientRect();
        const cw = Math.max(rect.width || 800, 400);
        const ch = Math.max(editor.scrollHeight || rect.height || 600, 600);

        // 始终创建新图层
        const layer = this._layerManager.createLayer();
        const canvas = this._canvasManager.createCanvas(layer.id, cw, ch);
        this._layerManager.bindCanvas(layer.id, canvas);
        this._canvasManager._currentLayerId = layer.id;

        this._ensureOverlay(editor, cw, ch);
        this._showToolbar();

        siyuan.showMessage("✅ 已添加 " + layer.name, 2000);
    }

    _ensureOverlay(editor, width, height) {
        // 查找当前编辑器对应的正确父容器
        const correctParent = editor.closest(".protyle-content") || editor.parentElement;

        // 如果已有 overlay 但挂错了地方（切换文档后），先移除
        if (this._overlayContainer && document.body.contains(this._overlayContainer)) {
            const currentParent = this._overlayContainer.parentElement;
            if (currentParent !== correctParent) {
                // 挂错文档了，移除重建
                try { currentParent.removeChild(this._overlayContainer); } catch (e) {}
                this._overlayContainer = null;
            }
        }

        // 画布覆盖整个编辑区宽度
        if (this._overlayContainer && document.body.contains(this._overlayContainer)) {
            // 复用现有 overlay，更新尺寸
            const existing = this._overlayContainer;
            existing.style.width = width + "px";
            existing.style.height = height + "px";
            this._addCanvasesToOverlay(existing);
            this._startResizeWatch(editor, width, height);
            return;
        }

        // 创建新的 overlay 容器
        const container = document.createElement("div");
        container.className = "drawing-overlay-container";
        container.style.cssText = "position:absolute;top:0;left:0;width:" + width + "px;height:" + height + "px;pointer-events:none;z-index:10;";

        if (correctParent) {
            if (getComputedStyle(correctParent).position === "static") correctParent.style.position = "relative";
            correctParent.appendChild(container);
        } else {
            document.body.appendChild(container);
        }

        this._overlayContainer = container;
        this._addCanvasesToOverlay(container);
        this._startResizeWatch(editor, width, height);
    }

    // 启动 resize 监听
    _startResizeWatch(editor, currentWidth, currentHeight) {
        const self = this;
        // 停止旧的监听
        this._stopResizeWatch();

        // 使用 ResizeObserver 监听编辑器容器大小变化
        if (typeof ResizeObserver !== "undefined") {
            this._resizeObserver = new ResizeObserver(function (entries) {
                const rect = editor.getBoundingClientRect();
                const newWidth = Math.max(rect.width || 800, 400);
                const newHeight = Math.max(editor.scrollHeight || rect.height || 600, 600);

                // 更新 overlay 容器尺寸
                if (self._overlayContainer) {
                    self._overlayContainer.style.width = newWidth + "px";
                    self._overlayContainer.style.height = newHeight + "px";
                }

                // 更新所有 canvas 的尺寸（保留内容）
                if (self._canvasManager) {
                    self._canvasManager.resizeCanvases(newWidth, newHeight);
                }
            });
            this._resizeObserver.observe(editor);
        }

        // 后备：同时监听 window resize
        this._resizeHandler = function () {
            const rect = editor.getBoundingClientRect();
            const newWidth = Math.max(rect.width || 800, 400);
            const newHeight = Math.max(editor.scrollHeight || rect.height || 600, 600);

            // 更新 overlay 容器尺寸
            if (self._overlayContainer) {
                self._overlayContainer.style.width = newWidth + "px";
                self._overlayContainer.style.height = newHeight + "px";
            }

            // 更新所有 canvas 的尺寸（保留内容）
            if (self._canvasManager) {
                self._canvasManager.resizeCanvases(newWidth, newHeight);
            }
        };
        window.addEventListener("resize", this._resizeHandler);
    }

    // 停止 resize 监听
    _stopResizeWatch() {
        if (this._resizeObserver) {
            try { this._resizeObserver.disconnect(); } catch (e) {}
            this._resizeObserver = null;
        }
        if (this._resizeHandler) {
            window.removeEventListener("resize", this._resizeHandler);
            this._resizeHandler = null;
        }
    }

    _addCanvasesToOverlay(container) {
        container.innerHTML = "";
        const layers = this._layerManager.getLayers();
        const self = this;
        layers.forEach(function (l) {
            const canvas = self._canvasManager._canvases[l.id];
            if (canvas) {
                canvas.style.display = l.visible ? "" : "none";
                container.appendChild(canvas);
            }
        });
        // 恢复选框 DOM（innerHTML 会清掉它）
        if (this._canvasManager && this._canvasManager._selectionRect) {
            try { container.appendChild(this._canvasManager._selectionRect); } catch (e) {}
        }
        if (this._canvasManager && this._canvasManager._floatCanvas) {
            try { container.appendChild(this._canvasManager._floatCanvas); } catch (e) {}
        }
        this._canvasManager._updatePointerEvents();
    }

    _rebuildOverlay(docId) {
        this._userClosedToolbar = false;  // 主动重建时重置标记
        this._removeOverlay();
        const editor = this._docManager ? this._docManager.getDocumentDOM() : null;
        if (!editor) return;

        const rect = editor.getBoundingClientRect();
        const cw = Math.max(rect.width || 800, 400);
        const ch = Math.max(editor.scrollHeight || rect.height || 600, 600);

        const layers = this._layerManager.getLayers();
        const self = this;
        layers.forEach(function (l) {
            if (!self._canvasManager._canvases[l.id]) {
                const canvas = self._canvasManager.createCanvas(l.id, cw, ch);
                self._layerManager.bindCanvas(l.id, canvas);
            }
            const canvas = self._canvasManager._canvases[l.id];
            if (canvas) {
                self._storage.loadLayerImage(docId, l.id, function (img) {
                    if (img) {
                        const ctx = canvas.getContext("2d");
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        ctx.drawImage(img, 0, 0);
                    }
                });
            }
        });

        this._ensureOverlay(editor, cw, ch);
        this._showToolbar();
    }

    _removeOverlay() {
        if (this._canvasManager) this._canvasManager.clearSelection();
        if (this._overlayContainer && document.body.contains(this._overlayContainer)) {
            Object.values(this._canvasManager._canvases).forEach(function (c) {
                if (c.parentNode) c.parentNode.removeChild(c);
            });
            try { this._overlayContainer.parentNode.removeChild(this._overlayContainer); } catch (e) {}
        }
        this._overlayContainer = null;
        this._stopResizeWatch();
    }

    // ========== 左侧浮动工具条 ==========
    _showToolbar() {
        if (this._toolbarEl && document.body.contains(this._toolbarEl)) this._removeToolbar();
        // 注册键盘事件（Delete 删除选区）
        if (!this._keydownHandler) {
            this._keydownHandler = this._onKeyDown.bind(this);
            document.addEventListener("keydown", this._keydownHandler, true);
        }

        const tb = document.createElement("div");
        tb.className = "drawing-float-toolbar";
        tb.style.cssText = "position:fixed;top:50%;transform:translateY(-50%);z-index:9999;" +
            "background:var(--b3-menu-background,#fff);border:1px solid var(--b3-border-color,#e0e0e0);" +
            "border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,0.12);padding:6px 4px;" +
            "display:flex;flex-direction:column;gap:2px;user-select:none;";

        const tools = [
            { icon: "🖱️", title: "选择", tool: "select" },
            { icon: "✏️", title: "画笔", tool: "brush" },
            { icon: "🧽", title: "橡皮擦", tool: "eraser" },
            { icon: "🖍️", title: "荧光笔", tool: "highlighter" },
            { type: "separator" },
            { icon: "↩️", title: "撤销上一笔", action: "undo" },
            { icon: "🗑️", title: "清空当前图层", action: "clear" },
            { icon: "💾", title: "保存图层", action: "save" },
            { type: "separator" },
            { icon: "📂", title: "图层管理", action: "layer-list" },
            { icon: "❌", title: "关闭绘图", action: "close" },
        ];

        const self = this;
        tools.forEach(function (item) {
            if (item.type === "separator") {
                const sep = document.createElement("div");
                sep.style.cssText = "height:1px;background:var(--b3-border-color,#e0e0e0);margin:4px 6px;";
                tb.appendChild(sep);
                return;
            }
            const btn = document.createElement("button");
            btn.className = "drawing-tool-btn";
            // 先设基础样式，再设 active 高亮（避免 cssText 覆盖）
            btn.style.cssText = "width:36px;height:36px;border:2px solid transparent;background:transparent;border-radius:8px;" +
                "cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;" +
                "transition:background 0.12s;color:#333;";
            // 关键修复：读取当前实际工具，而不是硬编码
            const currentTool = (self._canvasManager && self._canvasManager._currentTool) ? self._canvasManager._currentTool : "brush";
            if (item.tool === currentTool) {
                btn.classList.add("active");
                btn.style.background = "#e8f0fe";
                btn.style.border = "2px solid #1890ff";
            }
            btn.innerHTML = item.icon;
            btn.title = item.title;
            if (item.tool) btn.setAttribute("data-tool", item.tool);  // 双击笔切换工具时定位按钮

            btn.onmouseenter = function () {
                if (!this.classList.contains("active")) this.style.opacity = "0.72";
            };
            btn.onmouseleave = function () {
                if (!this.classList.contains("active")) {
                    this.style.opacity = "";
                    this.style.background = "transparent";
                    this.style.border = "2px solid transparent";
                } else {
                    // active 按钮保持高亮样式
                    this.style.background = "#e8f0fe";
                    this.style.border = "2px solid #1890ff";
                }
            };

            if (item.tool) {
                btn.onclick = function (e) {
                    const me = e.currentTarget;
                    // 方法一：用内联样式，不依赖 CSS 类
                    tb.querySelectorAll(".drawing-tool-btn").forEach(function (b) {
                        b.style.background = "transparent";
                        b.style.border = "2px solid transparent";
                        b.classList.remove("active");
                    });
                    me.style.background = "#e8f0fe";
                    me.style.border = "2px solid #1890ff";
                    me.classList.add("active");
                    if (self._canvasManager) self._canvasManager.setTool(item.tool);
                };
            } else if (item.action === "undo") {
                btn.onclick = function () {
                    if (self._canvasManager) {
                        const ok = self._canvasManager.undo();
                        if (ok) self._autoSave();
                    }
                };
            } else if (item.action === "clear") {
                btn.onclick = function () {
                    const current = self._layerManager ? self._layerManager.getCurrentLayer() : null;
                    if (current && self._canvasManager) self._canvasManager.clearLayer(current.id);
                };
            } else if (item.action === "save") {
                btn.onclick = function () { self._autoSave(); siyuan.showMessage("✅ 已保存", 2000); };
            } else if (item.action === "export") {
                btn.onclick = function () { self._showExportDialog(); };
            } else if (item.action === "layer-list") {
                btn.onclick = function () { self._showLayerListDialog(); };
            } else if (item.action === "close") {
                btn.onclick = function () { self._autoSave(); self._userClosedToolbar = true; self._removeOverlay(); self._removeToolbar(); };
            }

            tb.appendChild(btn);
        });

        // 颜色 + 大小控件（从 CanvasManager 读取当前值）
        const currentColor = (self._canvasManager && self._canvasManager._brushColor) ? self._canvasManager._brushColor : "#000000";
        const currentSize = (self._canvasManager && self._canvasManager._currentSize) ? self._canvasManager._currentSize : 3;
        const optsRow = document.createElement("div");
        optsRow.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:4px;margin-top:4px;padding-top:6px;border-top:1px solid var(--b3-border-color,#e0e0e0);";

        // 颜色圆点按钮（点击弹出取色面板）
        const colorBtn = document.createElement("div");
        colorBtn.id = "dd-color-btn";
        colorBtn.title = "画笔颜色 — 点击打开取色面板";
        colorBtn.style.cssText = "width:28px;height:28px;border-radius:50%;cursor:pointer;background:" + currentColor +
            ";border:2px solid #ddd;flex-shrink:0;";
        optsRow.appendChild(colorBtn);

        // 大小滑块
        const sizeWrapper = document.createElement("div");
        sizeWrapper.style.cssText = "display:flex;flex-direction:column;align-items:center;";
        sizeWrapper.innerHTML =
            '<input type="range" id="dd-size" min="1" max="50" value="' + currentSize + '" style="width:32px;cursor:pointer;">' +
            '<span id="dd-size-label" style="font-size:10px;color:#999;">' + currentSize + '</span>';
        optsRow.appendChild(sizeWrapper);

        tb.appendChild(optsRow);

        document.body.appendChild(tb);
        this._toolbarEl = tb;

        // ====== 颜色取色弹窗（点击颜色圆点打开） ======
        // 辅助：hex ↔ rgb 转换（外层作用域，popup 和 onclick 共享）
        const hexToRgb = function (hex) {
            const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
            return m ? parseInt(m[1], 16) + ", " + parseInt(m[2], 16) + ", " + parseInt(m[3], 16) : "";
        };
        const parseRgb = function (str) {
            const m = /(\d{1,3})\D+(\d{1,3})\D+(\d{1,3})/.exec(str);
            if (!m) return null;
            return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
        };

        let colorPopup = null;
        const buildColorPopup = function () {
            if (colorPopup) return colorPopup;
            const popup = document.createElement("div");
            popup.id = "dd-color-popup";
            popup.style.cssText = "position:fixed;z-index:10001;display:none;background:#fff;border:1px solid #ddd;" +
                "border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.18);padding:10px;flex-direction:column;align-items:center;gap:8px;";
            // 预设颜色 — 从设置读取
            const presets = self._loadSettings().presetColors || ["#000000", "#E02020", "#FFC000", "#2060E0", "#20A020"];
            let swatchesHtml = "";
            presets.forEach(function (c) {
                swatchesHtml += '<span data-color="' + c + '" style="width:22px;height:22px;background:' + c +
                    ';border-radius:4px;cursor:pointer;border:1px solid #ccc;" title="' + c + '"></span>';
            });
            const rgbStr = hexToRgb(currentColor);

            popup.innerHTML =
                '<input type="color" id="dd-popup-picker" value="' + currentColor + '" style="width:120px;height:36px;border:none;cursor:pointer;border-radius:4px;">' +
                '<div style="display:flex;align-items:center;gap:4px;font-size:12px;">' +
                '<span style="color:#666;">HEX:</span>' +
                '<input type="text" id="dd-popup-hex" value="' + currentColor + '" style="width:80px;font-size:12px;text-align:center;border:1px solid #ccc;border-radius:4px;padding:2px 4px;" placeholder="#000000" maxlength="7">' +
                '</div>' +
                '<div style="display:flex;align-items:center;gap:4px;font-size:12px;">' +
                '<span style="color:#666;">RGB:</span>' +
                '<input type="text" id="dd-popup-rgb" value="' + rgbStr + '" style="width:96px;font-size:12px;text-align:center;border:1px solid #ccc;border-radius:4px;padding:2px 4px;" placeholder="255, 0, 0">' +
                '</div>' +
                '<div style="display:flex;align-items:center;gap:4px;font-size:12px;">' +
                '<span style="color:#666;">透明:</span>' +
                '<input type="range" id="dd-popup-opacity" min="5" max="100" value="' + Math.round((self._canvasManager && self._canvasManager._currentOpacity || 1) * 100) + '" style="width:80px;">' +
                '<span id="dd-popup-opacity-label" style="font-size:11px;color:#999;min-width:28px;">' + Math.round((self._canvasManager && self._canvasManager._currentOpacity || 1) * 100) + '%</span>' +
                '</div>' +
                '<div id="dd-color-swatches" style="display:flex;gap:6px;margin-top:2px;flex-wrap:wrap;max-width:150px;">' +
                swatchesHtml +
                '</div>';
            document.body.appendChild(popup);

            // === 三向同步：picker ↔ hex ↔ rgb ===
            const picker = popup.querySelector("#dd-popup-picker");
            const hexInput = popup.querySelector("#dd-popup-hex");
            const rgbInput = popup.querySelector("#dd-popup-rgb");

            const applyColor = function (hex) {
                picker.value = hex;
                hexInput.value = hex;
                rgbInput.value = hexToRgb(hex);
                colorBtn.style.background = hex;
                if (self._canvasManager) self._canvasManager.setBrushColor(hex);
            };

            picker.oninput = function () {
                hexInput.value = this.value;
                rgbInput.value = hexToRgb(this.value);
                colorBtn.style.background = this.value;
                if (self._canvasManager) self._canvasManager.setBrushColor(this.value);
            };
            rgbInput.oninput = function () {
                const c = parseRgb(this.value.trim());
                if (c && c[0] <= 255 && c[1] <= 255 && c[2] <= 255) {
                    const hex = "#" + ((1 << 24) + (c[0] << 16) + (c[1] << 8) + c[2]).toString(16).slice(1);
                    applyColor(hex);
                }
            };
            rgbInput.onkeydown = function (e) {
                if (e.key === "Enter") {
                    e.preventDefault();
                    const c = parseRgb(this.value.trim());
                    if (c && c[0] <= 255 && c[1] <= 255 && c[2] <= 255) {
                        const hex = "#" + ((1 << 24) + (c[0] << 16) + (c[1] << 8) + c[2]).toString(16).slice(1);
                        applyColor(hex);
                    } else {
                        this.value = hexToRgb(picker.value);
                    }
                }
            };
            rgbInput.onblur = function () {
                const c = parseRgb(this.value.trim());
                if (!c || c[0] > 255 || c[1] > 255 || c[2] > 255) {
                    this.value = hexToRgb(picker.value);
                }
            };
            hexInput.oninput = function () {
                const val = this.value.trim();
                if (/^#[0-9a-fA-F]{6}$/.test(val)) {
                    picker.value = val;
                    colorBtn.style.background = val;
                    if (self._canvasManager) self._canvasManager.setBrushColor(val);
                }
            };
            hexInput.onkeydown = function (e) {
                if (e.key === "Enter") {
                    e.preventDefault();
                    let val = this.value.trim();
                    if (val.charAt(0) !== "#") val = "#" + val;
                    if (/^#[0-9a-fA-F]{6}$/.test(val)) {
                        this.value = val;
                        picker.value = val;
                        colorBtn.style.background = val;
                        if (self._canvasManager) self._canvasManager.setBrushColor(val);
                    } else {
                        this.value = picker.value; // 回退
                    }
                }
            };
            hexInput.onblur = function () {
                let val = this.value.trim();
                if (!val) { this.value = picker.value; return; }
                if (val.charAt(0) !== "#") val = "#" + val;
                if (/^#[0-9a-fA-F]{6}$/.test(val)) {
                    this.value = val;
                    picker.value = val;
                    colorBtn.style.background = val;
                    if (self._canvasManager) self._canvasManager.setBrushColor(val);
                } else {
                    this.value = picker.value;
                }
            };
            // === 透明度滑块 ===
            var opacitySlider = popup.querySelector("#dd-popup-opacity");
            var opacityLabel = popup.querySelector("#dd-popup-opacity-label");
            if (opacitySlider) {
                opacitySlider.oninput = function () {
                    var v = parseInt(this.value);
                    opacityLabel.textContent = v + "%";
                    if (self._canvasManager) self._canvasManager.setBrushOpacity(v / 100);
                };
            }

            // === 预设颜色块点击 ===
            popup.querySelector("#dd-color-swatches").onclick = function (e) {
                const swatch = e.target.closest("[data-color]");
                if (!swatch) return;
                applyColor(swatch.getAttribute("data-color"));
            };

            // 点击弹窗外关闭
            const closeHandler = function (ev) {
                if (popup.style.display === "flex" &&
                    !popup.contains(ev.target) && ev.target !== colorBtn) {
                    popup.style.display = "none";
                }
            };
            popup._closeHandler = closeHandler;
            document.addEventListener("pointerdown", closeHandler, true);

            colorPopup = popup;
            return popup;
        };

        // 点击颜色圆点 → 切换弹窗显示
        colorBtn.onclick = function (e) {
            e.stopPropagation();
            const popup = buildColorPopup();
            // 同步当前色到弹窗
            const cur = self._canvasManager ? self._canvasManager._brushColor : currentColor;
            popup.querySelector("#dd-popup-picker").value = cur;
            popup.querySelector("#dd-popup-hex").value = cur;
            popup.querySelector("#dd-popup-rgb").value = hexToRgb(cur);
            if (popup.style.display === "flex") {
                popup.style.display = "none";
            } else {
                // 定位在颜色按钮右侧
                const btnRect = colorBtn.getBoundingClientRect();
                popup.style.left = Math.min(btnRect.right + 8, window.innerWidth - 170) + "px";
                popup.style.top = Math.max(10, btnRect.top - 60) + "px";
                popup.style.display = "flex";
            }
        };

        // 销毁弹窗的方法（切换文档时调用）
        self._destroyColorPopup = function () {
            if (colorPopup) {
                if (colorPopup._closeHandler) {
                    document.removeEventListener("pointerdown", colorPopup._closeHandler, true);
                }
                if (colorPopup.parentNode) colorPopup.parentNode.removeChild(colorPopup);
                colorPopup = null;
            }
        };

        // 动态定位：根据编辑区左边缘计算位置（侧栏展开/收回时自动跟隨）
        this._updateToolbarPosition();
        this._startToolbarPositionWatch();

        // 绑定大小事件
        setTimeout(function () {
            const sizeInput = tb.querySelector("#dd-size");
            const sizeLabel = tb.querySelector("#dd-size-label");
            if (sizeInput) {
                sizeInput.oninput = function () {
                    if (sizeLabel) sizeLabel.textContent = this.value;
                    if (self._canvasManager) self._canvasManager.setBrushSize(parseInt(this.value));
                };
            }
        }, 100);
    }

    _removeToolbar() {
        // 先停止位置监听
        this._stopToolbarPositionWatch();
        if (this._toolbarEl && this._toolbarEl.parentNode) {
            try { this._toolbarEl.parentNode.removeChild(this._toolbarEl); } catch (e) {}
        }
        this._toolbarEl = null;
        // 销毁颜色取色弹窗
        if (this._destroyColorPopup) { this._destroyColorPopup(); this._destroyColorPopup = null; }
        // 移除键盘事件
        if (this._keydownHandler) {
            document.removeEventListener("keydown", this._keydownHandler, true);
            this._keydownHandler = null;
        }
    }

    // ========== 工具栏动态定位（跟随侧栏展开/收回） ==========
    _updateToolbarPosition() {
        if (!this._toolbarEl) return;
        const editor = this._docManager ? this._docManager.getDocumentDOM() : null;
        if (!editor) return;
        // 编辑区左边缘在视口中的 X 坐标
        const editorLeft = editor.getBoundingClientRect().left;
        // 工具栏放在编辑区左边缘向右 20px 的位置
        this._toolbarEl.style.left = (editorLeft + 20) + "px";
    }

    _startToolbarPositionWatch() {
        this._stopToolbarPositionWatch();
        const self = this;

        // 监听编辑器大小变化（侧栏展开/收回会触发）
        if (typeof ResizeObserver !== "undefined") {
            this._toolbarResizeObserver = new ResizeObserver(function () {
                self._updateToolbarPosition();
            });
            const editor = this._docManager ? this._docManager.getDocumentDOM() : null;
            if (editor) this._toolbarResizeObserver.observe(editor);
        }

        // 后备：window.resize 也更新
        this._toolbarResizeHandler = function () {
            self._updateToolbarPosition();
        };
        window.addEventListener("resize", this._toolbarResizeHandler);
    }

    _stopToolbarPositionWatch() {
        if (this._toolbarResizeObserver) {
            try { this._toolbarResizeObserver.disconnect(); } catch (e) {}
            this._toolbarResizeObserver = null;
        }
        if (this._toolbarResizeHandler) {
            window.removeEventListener("resize", this._toolbarResizeHandler);
            this._toolbarResizeHandler = null;
        }
    }

    toggleDrawing() {
        if (this._overlayContainer && document.body.contains(this._overlayContainer)) {
            this._removeOverlay();
            this._removeToolbar();
        } else {
            this._addLayerAndShow();
        }
    }

    // ========== 键盘事件 ==========
    _onKeyDown(e) {
        if (!this._overlayContainer || !this._canvasManager) return;

        // 焦点在编辑器内 → 不拦截任何快捷键
        const tag = document.activeElement ? document.activeElement.tagName : "";
        const isEditable = document.activeElement && (
            tag === "INPUT" || tag === "TEXTAREA" ||
            document.activeElement.isContentEditable ||
            document.activeElement.closest(".protyle-wysiwyg")
        );
        if (isEditable) return;

        // Ctrl+Z / ⌘Z → 撤销
        if ((e.ctrlKey || e.metaKey) && e.key === "z") {
            e.preventDefault();
            e.stopPropagation();
            this._canvasManager.undo();
            this._autoSave();
            return;
        }

        // Delete / Backspace → 删除选区
        if (this._canvasManager._hasSelection && (e.key === "Delete" || e.key === "Backspace")) {
            e.preventDefault();
            e.stopPropagation();
            this._canvasManager.deleteSelection();
            this._autoSave();
        }
    }

    // ========== 图层管理 Dialog ==========
    _showLayerListDialog() {
        const self = this;
        if (!this._layerManager) this._initManagers();
        this._syncDocumentLayers();

        // ★ 如果 root_id 还没解析完，等解析完再打开弹窗
        var docId = this._docManager ? this._docManager.getDocumentID() : null;
        if (!docId || !/^\d{14}-[a-z0-9]{7}$/.test(docId)) {
            siyuan.showMessage("⏳ 正在解析文档...", 1500);
            var checkCount = 0;
            var checkTimer = setInterval(function () {
                checkCount++;
                var id = self._docManager ? self._docManager.getDocumentID() : null;
                if (id && /^\d{14}-[a-z0-9]{7}$/.test(id)) {
                    clearInterval(checkTimer);
                    self._showLayerListDialog();  // 重新调用
                } else if (checkCount > 30) {
                    clearInterval(checkTimer);
                    siyuan.showMessage("⚠️ 文档解析超时", 3000);
                }
            }, 200);
            return;
        }

        const buildListHtml = function (layers, currentId) {
            if (layers.length === 0) return '<div style="padding:16px;color:#999;font-size:13px;">暂无图层，请先添加</div>';
            let html = "";
            layers.forEach(function (l) {
                const eye = l.visible ? "&#128065;" : "&#128064;";
                const active = l.id === currentId ? "background:#e8f0fe;" : "";
                const escapedName = (l.name || ("图层 " + l.id)).replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                html += '<div style="display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;cursor:pointer;' + active + '" data-lid="' + l.id + '">' +
                    '<button data-action="vis" data-lid="' + l.id + '" style="border:none;background:none;cursor:pointer;font-size:14px;">' + eye + '</button>' +
                    '<span data-name-lid="' + l.id + '" style="flex:1;font-size:13px;cursor:text;">' + escapedName + '</span>' +
                    '<button data-action="rename" data-lid="' + l.id + '" style="border:none;background:none;cursor:pointer;font-size:12px;color:#999;padding:2px 4px;" title="重命名">✎</button>' +
                    '<button data-action="del" data-lid="' + l.id + '" style="border:none;background:none;cursor:pointer;color:#f66;font-size:12px;">✕</button>' +
                    '</div>';
            });
            return html;
        };

        const layers = this._layerManager.getLayers();
        const currentId = this._layerManager.getCurrentLayerId();
        const listHtml = buildListHtml(layers, currentId);

        const html = '<div id="dlg-content" style="padding:16px;">' +
            '<h3 style="margin:0 0 12px 0;font-size:15px;">图层管理</h3>' +
            '<div id="dlg-layer-list">' + listHtml + '</div>' +
            '<button id="dlg-add-layer" style="margin-top:12px;padding:6px 14px;background:var(--b3-theme-primary,#1890ff);color:#fff;border:none;border-radius:6px;cursor:pointer;">+ 添加图层</button>' +
            '<button id="dlg-save" style="margin-top:12px;margin-left:8px;padding:6px 14px;background:#52c41a;color:#fff;border:none;border-radius:6px;cursor:pointer;">💾 保存</button>' +
            '</div>';

        // 关闭旧对话框（如果有）
        if (this._layerDialog) { try { this._layerDialog.destroy(); } catch (e) {} }
        var dlgDocId = this._docManager ? this._docManager.getDocumentID() : "";
        var dlgIdLabel = dlgDocId;
        const dialog = new siyuan.Dialog({ title: "图层管理 — " + dlgIdLabel, content: html, width: "400px", height: "auto" });
        this._layerDialog = dialog;
        const el = dialog.element;
        if (!el) { this._layerDialog = null; return; }

        // 事件委托
        const content = el.querySelector("#dlg-content") || el;
        content.onclick = function (e) {
            // 眼睛按钮
            const visBtn = e.target.closest && e.target.closest('[data-action="vis"]');
            if (visBtn) {
                e.preventDefault();
                const id = parseInt(visBtn.getAttribute("data-lid"));
                const layer = self._layerManager.getLayer(id);
                if (!layer) return;
                if (layer.visible) {
                    self._layerManager.hideLayer(id);
                } else {
                    self._layerManager.showLayer(id);
                }
                const canvas = self._canvasManager._canvases[id];
                if (canvas) canvas.style.display = layer.visible ? "" : "none";
                const listEl = el.querySelector("#dlg-layer-list");
                if (listEl) listEl.innerHTML = buildListHtml(self._layerManager.getLayers(), self._layerManager.getCurrentLayerId());
                return;
            }
            // 删除按钮
            const delBtn = e.target.closest && e.target.closest('[data-action="del"]');
            if (delBtn) {
                e.preventDefault();
                const id = parseInt(delBtn.getAttribute("data-lid"));
                // 同时删除保存在文件夹里的图层图片
                const docId = self._docManager ? self._docManager.getDocumentID() : null;
                if (docId && self._storage) {
                    self._storage.deleteLayerImage(docId, id);
                }
                self._layerManager.deleteLayer(id);
                self._canvasManager.removeCanvas(id);
                self._autoSave();  // 删除后立即保存，更新 config
                const listEl = el.querySelector("#dlg-layer-list");
                if (listEl) listEl.innerHTML = buildListHtml(self._layerManager.getLayers(), self._layerManager.getCurrentLayerId());
                return;
            }
            // 重命名按钮
            const renameBtn = e.target.closest && e.target.closest('[data-action="rename"]');
            if (renameBtn) {
                e.preventDefault();
                e.stopPropagation();
                const id = parseInt(renameBtn.getAttribute("data-lid"));
                const layer = self._layerManager.getLayer(id);
                if (!layer) return;
                const nameSpan = el.querySelector('[data-name-lid="' + id + '"]');
                if (!nameSpan) return;
                const oldName = layer.name || ("图层 " + id);
                // 替换为输入框
                const input = document.createElement("input");
                input.type = "text";
                input.value = oldName;
                input.style.cssText = "flex:1;font-size:13px;border:1px solid #1890ff;border-radius:4px;padding:2px 6px;outline:none;min-width:0;";
                input.setAttribute("data-rename-input", id);
                nameSpan.replaceWith(input);
                input.focus();
                input.select();
                const commitRename = function () {
                    const newName = input.value.trim() || oldName;
                    self._layerManager.renameLayer(id, newName);
                    const listEl2 = el.querySelector("#dlg-layer-list");
                    if (listEl2) listEl2.innerHTML = buildListHtml(self._layerManager.getLayers(), self._layerManager.getCurrentLayerId());
                };
                input.onkeydown = function (ke) {
                    if (ke.key === "Enter") { ke.preventDefault(); commitRename(); }
                    if (ke.key === "Escape") { ke.preventDefault(); commitRename(); }
                };
                input.onblur = function () { commitRename(); };
                return;
            }
            // 点击行：进入该图层的绘图模式
            const row = e.target.closest && e.target.closest("[data-lid]");
            if (row && !e.target.closest("[data-action]")) {
                const id = parseInt(row.getAttribute("data-lid"));
                if (isNaN(id)) return;
                const layer = self._layerManager.getLayer(id);
                if (!layer) return;

                if (!layer.visible) {
                    self._layerManager.showLayer(id);
                    const canvas = self._canvasManager._canvases[id];
                    if (canvas) canvas.style.display = "";
                }

                self._layerManager.setCurrentLayer(id);
                self._canvasManager._currentLayerId = id;
                self._canvasManager.clearSelection();
                self._canvasManager.clearHistory();
                self._canvasManager._updatePointerEvents();
                const editor = self._docManager ? self._docManager.getDocumentDOM() : null;
                if (editor) {
                    const rect = editor.getBoundingClientRect();
                    const cw = Math.max(rect.width || 800, 400);
                    const ch = Math.max(editor.scrollHeight || rect.height || 600, 600);
                    self._ensureOverlay(editor, cw, ch);
                    self._showToolbar();
                }

                const listEl = el.querySelector("#dlg-layer-list");
                if (listEl) listEl.innerHTML = buildListHtml(self._layerManager.getLayers(), self._layerManager.getCurrentLayerId());
                return;
            }
        };

        // 添加图层 / 保存按钮
        el.querySelector("#dlg-add-layer").onclick = function () {
            try { dialog.destroy(); } catch (e) {}
            self._layerDialog = null;
            self._addLayerAndShow();
        };
        el.querySelector("#dlg-save").onclick = function () {
            if (self._layerManager && self._storage) {
                var docId = self._docManager ? self._docManager.getDocumentID() : null;
                if (!docId || !/^\d{14}-[a-z0-9]{7}$/.test(docId)) {
                    siyuan.showMessage("⚠️ 文档 ID 尚未就绪，请稍后再试", 2000);
                    return;
                }
                var cfg2 = self._layerManager.toConfig();
                cfg2._docTitle = self._docManager ? self._docManager.getDocumentTitle() : docId;
                self._storage.save(docId, cfg2, self._layerManager.getLayers());
                siyuan.showMessage("✅ 已保存", 2000);
            }
        };
    }

    // ========== 导出格式选择弹窗 ==========
    _showExportDialog() {
        if (!this._layerManager) this._initManagers();
        this._syncDocumentLayers();
        var self = this;  // ★ 必须在所有分支之前声明

        this._autoSave();

        const editor = this._docManager ? this._docManager.getDocumentDOM() : null;
        if (!editor) { siyuan.showMessage("⚠️ 请先打开一个文档", 2000); return; }

        const layers = this._layerManager.getLayers();
        const visibleLayers = layers.filter(function (l) { return l.visible && l.canvas; });
        if (layers.length === 0) { siyuan.showMessage("⚠️ 请先添加图层", 2000); return; }

        const popup = document.createElement("div");
        popup.style.cssText = "position:fixed;z-index:10002;background:#fff;border:1px solid #ddd;" +
            "border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.18);padding:14px 18px;max-height:80vh;overflow-y:auto;" +
            "display:flex;flex-direction:column;gap:6px;left:50%;top:50%;transform:translate(-50%,-50%);min-width:260px;";

        // 图层列表
        var layerRows = "";
        layers.forEach(function (l) {
            var checked = l.visible && l.canvas ? " checked" : "";
            var disabled = !l.canvas ? " disabled" : "";
            var name = (l.name || ("图层 " + l.id)).replace(/"/g, "&quot;").replace(/</g, "&lt;");
            var eye = l.visible ? "👁" : "👁‍🗨";
            layerRows += '<label style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:13px;cursor:pointer;">' +
                '<input type="checkbox" class="dd-export-layer" data-lid="' + l.id + '"' + checked + disabled + '>' +
                '<span style="flex:1;">' + eye + ' ' + name + '</span>' +
                '</label>';
        });

        popup.innerHTML =
            '<div style="font-size:14px;font-weight:600;">导出图层</div>' +
            '<div style="font-size:11px;color:#999;margin-bottom:4px;">勾选要合并的图层</div>' +
            '<div id="dd-export-layers" style="max-height:200px;overflow-y:auto;">' + layerRows + '</div>' +
            '<div style="display:flex;gap:8px;margin-top:4px;">' +
            '<button id="dd-export-select-all" style="font-size:11px;border:none;background:none;color:#1890ff;cursor:pointer;padding:0;">全选</button>' +
            '<button id="dd-export-deselect-all" style="font-size:11px;border:none;background:none;color:#999;cursor:pointer;padding:0;">取消</button>' +
            '</div>' +
            '<div style="display:flex;gap:8px;margin-top:8px;">' +
            '<button id="dd-export-png" style="flex:1;padding:8px 0;font-size:13px;border:1px solid #1890ff;background:#1890ff;color:#fff;border-radius:6px;cursor:pointer;">🖼️ PNG</button>' +
            '<button id="dd-export-pdf" style="flex:1;padding:8px 0;font-size:13px;border:1px solid #ddd;background:#f5f5f5;border-radius:6px;cursor:pointer;">📄 PDF</button>' +
            '</div>';
        document.body.appendChild(popup);

        // 获取当前勾选的图层 ID 列表
        var getSelectedIds = function () {
            var ids = [];
            popup.querySelectorAll(".dd-export-layer:checked").forEach(function (cb) {
                ids.push(parseInt(cb.getAttribute("data-lid")));
            });
            return ids;
        };

        // 全选 / 取消
        popup.querySelector("#dd-export-select-all").onclick = function () {
            popup.querySelectorAll(".dd-export-layer:not([disabled])").forEach(function (cb) { cb.checked = true; });
        };
        popup.querySelector("#dd-export-deselect-all").onclick = function () {
            popup.querySelectorAll(".dd-export-layer").forEach(function (cb) { cb.checked = false; });
        };

        popup.querySelector("#dd-export-png").onclick = function () {
            var ids = getSelectedIds();
            closePopup();
            if (ids.length === 0) { siyuan.showMessage("⚠️ 请至少勾选一个图层", 2000); return; }
            window._ddExportMsgId = siyuan.showMessage("📸 正在截图文档...", -1);
            if (self._exportManager) self._exportManager.exportPNG(ids);
        };
        popup.querySelector("#dd-export-pdf").onclick = function () {
            var ids = getSelectedIds();
            closePopup();
            if (ids.length === 0) { siyuan.showMessage("⚠️ 请至少勾选一个图层", 2000); return; }
            window._ddExportMsgId = siyuan.showMessage("📸 正在截图文档...", -1);
            self._exportPDF(ids);
        };

        var closePopup = function () {
            try { document.body.removeChild(popup); } catch (e) {}
            document.removeEventListener("pointerdown", outsideHandler, true);
        };

        var outsideHandler = function (ev) {
            if (!popup.contains(ev.target)) closePopup();
        };
        setTimeout(function () {
            document.addEventListener("pointerdown", outsideHandler, true);
        }, 100);
    }

    // ========== PDF 导出（接受选中图层 ID 列表） ==========
    _exportPDF(selectedIds) {
        var self = this;
        var layers = this._layerManager.getLayers();
        var selectedLayers = layers.filter(function (l) { return selectedIds.indexOf(l.id) >= 0 && l.canvas; });
        if (selectedLayers.length === 0) {
            siyuan.showMessage("⚠️ 所选图层无可导出画布", 2000);
            return;
        }

        // 合并所选图层为一张画布
        var mergeLayers = function (targetCanvas) {
            var firstCanvas = selectedLayers[0].canvas;
            targetCanvas.width = firstCanvas.width;
            targetCanvas.height = firstCanvas.height;
            var ctx = targetCanvas.getContext("2d");
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
            selectedLayers.forEach(function (layer) { ctx.drawImage(layer.canvas, 0, 0); });
        };

        // 平板端：尝试截文档 + 图层合并 → 构建 PDF → 上传预览
        if (!IS_DESKTOP && typeof _siyuanFetchPost === "function") {
            var mc = document.createElement("canvas");
            mergeLayers(mc);
            var docId = this._docManager ? this._docManager.getDocumentID() : "export";

            var _uploadPdfBlob = function (finalCanvas) {
                var pdfBlob = self._buildPdfBlobFromCanvas(finalCanvas);
                if (!pdfBlob) { self._showExportPreview(null); return; }
                var ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
                var docTitle2 = "";
                try { docTitle2 = self._docManager ? self._docManager.getDocumentTitle() : ""; } catch (e) {}
                if (!docTitle2) docTitle2 = docId;
                docTitle2 = docTitle2.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 80);
                var fn = docTitle2 + "_" + ts + ".pdf";
                var formData = new FormData();
                formData.append("file", pdfBlob, fn);
                formData.append("type", "application/pdf");
                _siyuanFetchPost("/api/export/exportAsFile", formData, function (resp) {
                    if (resp && resp.data && typeof resp.data === "object" && resp.data.file) {
                        self._showExportPreview(resp.data.file);
                    } else if (resp && typeof resp.data === "string" && resp.data.length > 5) {
                        self._showExportPreview(resp.data);
                    } else {
                        self._showExportPreview(null);
                    }
                });
            };

            var editor = this._docManager ? this._docManager.getDocumentDOM() : null;
            if (editor && this._exportManager) {
                window._ddExportMsgId = siyuan.showMessage("📸 正在截图文档...", -1);
                this._exportManager._ensureHtml2Canvas(function (h2c) {
                    if (h2c) {
                        h2c(editor, { backgroundColor: "#ffffff", scale: 3, useCORS: true, logging: false }).then(function (docCanvas) {
                            var finalC = document.createElement("canvas");
                            finalC.width = docCanvas.width; finalC.height = docCanvas.height;
                            var fctx = finalC.getContext("2d");
                            fctx.drawImage(docCanvas, 0, 0);
                            var sx = docCanvas.width / mc.width, sy = docCanvas.height / mc.height;
                            fctx.save(); fctx.scale(sx, sy);
                            selectedLayers.forEach(function (l) { fctx.drawImage(l.canvas, 0, 0); });
                            fctx.restore();
                            _uploadPdfBlob(finalC);
                        }).catch(function () { _uploadPdfBlob(mc); });
                    } else { _uploadPdfBlob(mc); }
                });
            } else { _uploadPdfBlob(mc); }
            return;
        }

        // 桌面端：尝试截取文档内容（走 html2canvas）
        var editor2 = this._docManager ? this._docManager.getDocumentDOM() : null;
        if (editor2 && this._exportManager) {
            siyuan.showMessage("📸 正在截图文档内容...", 2000);
            this._exportManager._ensureHtml2Canvas(function (h2c) {
                if (h2c) {
                    h2c(editor2, {
                        backgroundColor: "#ffffff",
                        scale: 3,
                        useCORS: true,
                        logging: false
                    }).then(function (docCanvas) {
                        // 合并：文档 + 图层
                        var mergeCanvas = document.createElement("canvas");
                        mergeCanvas.width = docCanvas.width;
                        mergeCanvas.height = docCanvas.height;
                        var ctx = mergeCanvas.getContext("2d");
                        ctx.drawImage(docCanvas, 0, 0);
                        var firstCanvas = selectedLayers[0].canvas;
                        var scaleX = docCanvas.width / firstCanvas.width;
                        var scaleY = docCanvas.height / firstCanvas.height;
                        ctx.save();
                        ctx.scale(scaleX, scaleY);
                        selectedLayers.forEach(function (layer) { ctx.drawImage(layer.canvas, 0, 0); });
                        ctx.restore();
                        self._buildAndDownloadPDF(mergeCanvas);
                    }).catch(function () {
                        // html2canvas 失败，只用图层
                        var fallback = document.createElement("canvas");
                        mergeLayers(fallback);
                        self._buildAndDownloadPDF(fallback);
                    });
                } else {
                    // html2canvas 不可用
                    var fallback = document.createElement("canvas");
                    mergeLayers(fallback);
                    self._buildAndDownloadPDF(fallback);
                }
            });
        } else {
            // 无编辑器，只用图层
            var fallback = document.createElement("canvas");
            mergeLayers(fallback);
            self._buildAndDownloadPDF(fallback);
        }
    }

    // 生成导出文件名：文档标题_图层名.扩展名
    _makeExportName(docId, ext) {
        var title = "";
        try { title = this._docManager ? this._docManager.getDocumentTitle() : ""; } catch (e) {}
        if (!title) title = docId;
        // 替换文件名非法字符
        title = title.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 80);
        var ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        return title + "_" + ts + ext;
    }

    // PDF blob 构建（独立于下载，供平板端上传用）
    _buildPdfBlobFromCanvas(c) {
        var jpegUrl = c.toDataURL("image/jpeg", 0.92);
        var jpegB64 = jpegUrl.replace(/^data:image\/jpeg;base64,/, "");
        var jpegBytes = atob(jpegB64);
        var w = c.width, h = c.height;
        var arr = [], off = {};
        var ps = function (s) { for (var i = 0; i < s.length; i++) arr.push(s.charCodeAt(i)); };
        ps("%PDF-1.4\n");
        off[1] = arr.length; ps("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
        off[2] = arr.length; ps("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
        off[3] = arr.length; ps("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + w + " " + h + "] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>\nendobj\n");
        var stream = "q\n" + w + " 0 0 " + h + " 0 0 cm\n/Im0 Do\nQ";
        off[4] = arr.length; ps("4 0 obj\n<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream\nendobj\n");
        off[5] = arr.length; ps("5 0 obj\n<< /Type /XObject /Subtype /Image /Width " + w + " /Height " + h + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + jpegBytes.length + " >>\nstream\n");
        for (var i = 0; i < jpegBytes.length; i++) arr.push(jpegBytes.charCodeAt(i));
        ps("\nendstream\nendobj\n");
        var xo = arr.length;
        ps("xref\n0 6\n0000000000 65535 f \n");
        for (var o = 1; o <= 5; o++) { var p = "" + off[o]; while (p.length < 10) p = "0" + p; ps(p + " 00000 n \n"); }
        ps("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xo + "\n%%EOF");
        return new Blob([new Uint8Array(arr)], { type: "application/pdf" });
    }

    // 导出预览弹窗（平板端和桌面端共用）
    _showExportPreview(serverUrl) {
        if (window._ddExportMsgId) { try { siyuan.hideMessage(window._ddExportMsgId); } catch(e) {} window._ddExportMsgId = null; }
        var self = this;
        var overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;z-index:10010;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;";
        var buttonsHtml;
        if (serverUrl) {
            buttonsHtml = '<button id="dd-pv-link" style="margin-top:10px;padding:8px 20px;background:#1890ff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">🌐 在浏览器中查看</button>';
        } else if (IS_DESKTOP) {
            buttonsHtml = '<button id="dd-pv-save" style="margin-top:10px;padding:8px 20px;background:#1890ff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">💾 保存到本地</button>';
        } else {
            buttonsHtml = '<div style="margin-top:8px;display:flex;gap:8px;">' +
              '<button id="dd-pv-save" style="padding:7px 14px;background:#1890ff;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:13px;">💾 保存</button>' +
              '<button id="dd-pv-browser" style="padding:7px 14px;background:#52c41a;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:13px;">🌐 浏览器打开</button>' +
              '</div>';
        }
        overlay.innerHTML =
            '<div style="background:#fff;border-radius:10px;padding:14px;max-width:92vw;max-height:90vh;display:flex;flex-direction:column;align-items:center;box-shadow:0 8px 32px rgba(0,0,0,0.3);overflow-y:auto;">' +
            '<div style="font-size:14px;font-weight:600;margin-bottom:8px;">导出预览</div>' +
            '<div style="margin-top:6px;font-size:11px;color:#999;">导出完成</div>' +
            buttonsHtml +
            '<button id="dd-pv-close" style="margin-top:8px;padding:7px 18px;background:#eee;border:1px solid #ddd;border-radius:5px;cursor:pointer;font-size:13px;">关闭</button>' +
            '</div>';
        document.body.appendChild(overlay);

        if (serverUrl) {
            overlay.querySelector("#dd-pv-link").onclick = function () {
                var a = document.createElement("a");
                a.href = serverUrl; a.target = "_blank"; a.rel = "noopener";
                document.body.appendChild(a); a.click();
                setTimeout(function () { document.body.removeChild(a); }, 1000);
            };
        } else if (IS_DESKTOP) {
            overlay.querySelector("#dd-pv-save").onclick = function () {
                siyuan.showMessage("⚠️ 请通过 PNG 导出后保存", 3000);
            };
        } else {
            overlay.querySelector("#dd-pv-save").onclick = function () {
                siyuan.showMessage("⚠️ 请通过 PNG 导出", 3000);
            };
            overlay.querySelector("#dd-pv-browser").onclick = function () {
                siyuan.showMessage("⚠️ 请通过 PNG 导出", 3000);
            };
        }
        overlay.querySelector("#dd-pv-close").onclick = function () { overlay.remove(); };
        overlay.addEventListener("click", function (ev) { if (ev.target === overlay) overlay.remove(); });
    }

    _buildAndDownloadPDF(mergeCanvas) {

        // 获取 JPEG 数据（PDF 中用 JPEG 更小）
        const jpegDataUrl = mergeCanvas.toDataURL("image/jpeg", 0.92);
        const jpegBase64 = jpegDataUrl.replace(/^data:image\/jpeg;base64,/, "");
        const jpegBytes = atob(jpegBase64);
        const imgW = mergeCanvas.width;
        const imgH = mergeCanvas.height;

        // === 构建最小 PDF（纯手工，无外部依赖） ===
        const pdfPutStr = function (s) { arr.push.apply(arr, Array.from(unescape(encodeURIComponent(s))).map(function (c) { return c.charCodeAt(0); })); };
        const pdfPut = function () { for (var i = 0; i < arguments.length; i++) arr.push(arguments[i]); };
        var arr = [];
        var offsets = {};

        // Header
        pdfPutStr("%PDF-1.4\n");

        // Object 1: Catalog
        offsets[1] = arr.length;
        pdfPutStr("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

        // Object 2: Pages
        offsets[2] = arr.length;
        pdfPutStr("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");

        // Object 3: Page
        offsets[3] = arr.length;
        pdfPutStr("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + imgW + " " + imgH + "] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>\nendobj\n");

        // Object 4: Content stream
        var stream = "q\n" + imgW + " 0 0 " + imgH + " 0 0 cm\n/Im0 Do\nQ";
        offsets[4] = arr.length;
        pdfPutStr("4 0 obj\n<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream\nendobj\n");

        // Object 5: Image XObject
        offsets[5] = arr.length;
        pdfPutStr("5 0 obj\n<< /Type /XObject /Subtype /Image /Width " + imgW + " /Height " + imgH +
            " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + jpegBytes.length + " >>\nstream\n");
        for (var i = 0; i < jpegBytes.length; i++) arr.push(jpegBytes.charCodeAt(i));
        pdfPutStr("\nendstream\nendobj\n");

        // Cross-reference table
        var xrefOffset = arr.length;
        pdfPutStr("xref\n0 6\n0000000000 65535 f \n");
        for (var o = 1; o <= 5; o++) {
            var pos = "" + offsets[o];
            while (pos.length < 10) pos = "0" + pos;
            pdfPutStr(pos + " 00000 n \n");
        }

        // Trailer
        pdfPutStr("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xrefOffset + "\n%%EOF");

        // 下载
        const blob = new Blob([new Uint8Array(arr)], { type: "application/pdf" });
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const docId = this._docManager ? this._docManager.getDocumentID() : "export";
        const fileName = "drawing-" + docId + "-" + timestamp + ".pdf";

        if (IS_DESKTOP && fs) {
            // 桌面端写文件
            var exportDir = this._loadSettings().exportPath || (this._pluginDir + "/exports");
            try {
                if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
                var reader = new FileReader();
                reader.onload = function () {
                    var buf = Buffer.from(reader.result.split(",")[1], "base64");
                    var outPath = exportDir + "/" + fileName;
                    fs.writeFileSync(outPath, buf);
                    siyuan.showMessage("✅ 已保存：" + outPath, 4000);
                };
                reader.readAsDataURL(blob);
            } catch (e) { siyuan.showMessage("❌ 导出失败：" + e.message, 4000); }
        } else {
            // 移动端触发下载
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            siyuan.showMessage("✅ 已保存到下载目录 → " + fileName, 5000);
        }
    }

    // ========== 设置 Dialog ==========
    _openSettings() {
        const self = this;
        // 从持久化存储加载当前设置
        const cfg = this._loadSettings();
        const curColor = cfg.brushColor || "#000000";
        const curSize = cfg.brushSize || 3;
        const curOpacity = cfg.brushOpacity || 100;
        const curHighlighterSize = cfg.highlighterSize || 20;
        const curHighlighterOpacity = cfg.highlighterOpacity || 60;
        const curAutoSave = cfg.autoSave !== false;
        const curFingerDoubleTap = cfg.fingerDoubleTapEnabled !== false;
        const curTwoFingerUndo = cfg.twoFingerUndoEnabled !== false;
        const curExportPath = cfg.exportPath || "";
        const presetColors = cfg.presetColors || ["#000000", "#E02020", "#FFC000", "#2060E0", "#20A020"];

        // 生成预设颜色 HTML
        const buildPresetHtml = function (colors) {
            let h = "";
            colors.forEach(function (c, i) {
                h += '<span data-idx="' + i + '" data-color="' + c + '" style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;background:' + c +
                    ';border-radius:4px;cursor:pointer;border:1px solid #ccc;position:relative;flex-shrink:0;" title="' + c + '">' +
                    '<span data-action="del-preset" data-idx="' + i + '" style="position:absolute;top:-6px;right:-6px;width:14px;height:14px;background:#f66;color:#fff;border-radius:50%;font-size:9px;line-height:14px;text-align:center;cursor:pointer;display:none;">×</span>' +
                    '</span>';
            });
            return h;
        };

        const html = '<div style="padding:20px;font-size:13px;">' +
            '<h3 style="margin:0 0 12px 0;">文档绘图 — 设置</h3>' +
            '<div style="margin-bottom:12px;">' +
            '<label>默认画笔大小：</label>' +
            '<div style="display:flex;align-items:center;gap:8px;margin-top:4px;">' +
            '<input type="range" id="setting-brush-size" min="1" max="50" value="' + curSize + '" style="width:100px;">' +
            '<input type="number" id="setting-brush-size-num" min="1" max="50" value="' + curSize + '" style="width:60px;font-size:13px;text-align:center;border:1px solid #ddd;border-radius:4px;padding:2px 4px;">' +
            '<span style="font-size:12px;color:#999;">px</span>' +
            '</div>' +
            '</div>' +
            '<div style="margin-bottom:12px;">' +
            '<label>默认不透明度：</label>' +
            '<div style="display:flex;align-items:center;gap:8px;margin-top:4px;">' +
            '<input type="range" id="setting-brush-opacity" min="5" max="100" value="' + curOpacity + '" style="width:100px;">' +
            '<span id="setting-opacity-label" style="font-size:13px;">' + curOpacity + '%</span>' +
            '</div>' +
            '</div>' +
            '<div style="margin-bottom:12px;">' +
            '<label>荧光笔默认粗细：</label>' +
            '<div style="display:flex;align-items:center;gap:8px;margin-top:4px;">' +
            '<input type="range" id="setting-highlighter-size" min="1" max="50" value="' + curHighlighterSize + '" style="width:100px;">' +
            '<input type="number" id="setting-highlighter-size-num" min="1" max="50" value="' + curHighlighterSize + '" style="width:60px;font-size:13px;text-align:center;border:1px solid #ddd;border-radius:4px;padding:2px 4px;">' +
            '<span style="font-size:12px;color:#999;">px</span>' +
            '</div>' +
            '</div>' +
            '<div style="margin-bottom:12px;">' +
            '<label>荧光笔默认透明度：</label>' +
            '<div style="display:flex;align-items:center;gap:8px;margin-top:4px;">' +
            '<input type="range" id="setting-highlighter-opacity" min="5" max="100" value="' + curHighlighterOpacity + '" style="width:100px;">' +
            '<span id="setting-hl-opacity-label" style="font-size:13px;">' + curHighlighterOpacity + '%</span>' +
            '</div>' +
            '</div>' +
            '<div style="margin-bottom:12px;">' +
            '<label>默认画笔颜色：</label>' +
            '<div style="margin-top:4px;">' +
            '<input type="color" id="setting-brush-color" value="' + curColor + '" style="width:32px;height:32px;border:none;cursor:pointer;border-radius:4px;">' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:4px;margin-top:4px;font-size:12px;">' +
            '<span style="color:#666;width:32px;">HEX:</span>' +
            '<input type="text" id="setting-brush-color-hex" value="' + curColor + '" style="width:90px;font-size:13px;text-align:center;border:1px solid #ddd;border-radius:4px;padding:3px 6px;" placeholder="#000000" maxlength="7">' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:4px;margin-top:4px;font-size:12px;">' +
            '<span style="color:#666;width:32px;">RGB:</span>' +
            '<input type="text" id="setting-brush-color-rgb" value="' + (function (h) { var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h); return m ? parseInt(m[1], 16) + ", " + parseInt(m[2], 16) + ", " + parseInt(m[3], 16) : ""; })(curColor) + '" style="width:90px;font-size:13px;text-align:center;border:1px solid #ddd;border-radius:4px;padding:3px 6px;" placeholder="255, 0, 0">' +
            '</div>' +
            '</div>' +
            // 预设颜色集
            '<div style="margin-bottom:12px;">' +
            '<label>预设颜色集：</label>' +
            '<div style="display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap;" id="setting-presets">' +
            buildPresetHtml(presetColors) +
            '<button id="setting-add-preset" title="添加当前颜色" style="width:24px;height:24px;border:1px dashed #aaa;background:transparent;border-radius:4px;cursor:pointer;font-size:14px;line-height:22px;color:#888;flex-shrink:0;">+</button>' +
            '</div>' +
            '</div>' +
            '<div style="margin-bottom:12px;">' +
            '<label><input type="checkbox" id="setting-auto-save"' + (curAutoSave ? ' checked' : '') + '> 关闭时自动保存</label>' +
            '</div>' +
            '<div style="margin-bottom:12px;">' +
            '<label>导出文件存放位置（桌面端）：</label>' +
            '<div style="margin-top:4px;">' +
            '<input type="text" id="setting-export-path" value="' + curExportPath.replace(/"/g, "&quot;") + '" style="width:100%;font-size:12px;border:1px solid #ddd;border-radius:4px;padding:4px 6px;" placeholder="默认：插件目录/exports/">' +
            '<div style="font-size:10px;color:#999;margin-top:2px;">' + (IS_DESKTOP ? '留空使用默认位置' : '平板端通过浏览器下载，路径设置同步后可切换桌面端使用') + '</div>' +
            '</div>' +
            '</div>' +
            '<div style="margin-bottom:12px;">' +
            '<label>手势控制：</label>' +
            '<div style="margin-top:4px;">' +
            '<label><input type="checkbox" id="setting-finger-doubletap"' + (curFingerDoubleTap ? ' checked' : '') + '> 手指双击切换画笔/橡皮</label><br>' +
            '<label><input type="checkbox" id="setting-twofinger-undo"' + (curTwoFingerUndo ? ' checked' : '') + '> 双指点击撤销</label>' +
            '</div>' +
            '</div>' +
            '<button id="setting-save" style="padding:6px 16px;background:var(--b3-theme-primary,#1890ff);color:#fff;border:none;border-radius:4px;cursor:pointer;">保存设置</button>' +
            '</div>';

        const dialog = new siyuan.Dialog({ title: "文档绘图 — 设置", content: html, width: "420px", height: "auto" });
        const el = dialog.element;
        if (!el) return;

        // 颜色选择器 ↔ HEX ↔ RGB 三向同步
        const colorInput = el.querySelector("#setting-brush-color");
        const colorHexInput = el.querySelector("#setting-brush-color-hex");
        const colorRgbInput = el.querySelector("#setting-brush-color-rgb");
        const setHexRgb = function (h) {
            return (function (hex) { var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex); return m ? parseInt(m[1], 16) + ", " + parseInt(m[2], 16) + ", " + parseInt(m[3], 16) : ""; })(h);
        };
        const setParseRgb = function (str) {
            var m = /(\d{1,3})\D+(\d{1,3})\D+(\d{1,3})/.exec(str);
            if (!m) return null;
            var r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
            if (r > 255 || g > 255 || b > 255) return null;
            return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
        };
        if (colorInput && colorHexInput && colorRgbInput) {
            colorInput.oninput = function () {
                colorHexInput.value = this.value;
                colorRgbInput.value = setHexRgb(this.value);
            };
            colorHexInput.oninput = function () {
                var val = this.value.trim();
                if (/^#[0-9a-fA-F]{6}$/.test(val)) {
                    colorInput.value = val;
                    colorRgbInput.value = setHexRgb(val);
                }
            };
            colorHexInput.onblur = function () {
                var val = this.value.trim();
                if (!val) { this.value = colorInput.value; colorRgbInput.value = setHexRgb(colorInput.value); return; }
                if (val.charAt(0) !== "#") val = "#" + val;
                if (/^#[0-9a-fA-F]{6}$/.test(val)) {
                    this.value = val;
                    colorInput.value = val;
                    colorRgbInput.value = setHexRgb(val);
                } else {
                    this.value = colorInput.value;
                }
            };
            colorRgbInput.oninput = function () {
                var hex = setParseRgb(this.value.trim());
                if (hex) { colorInput.value = hex; colorHexInput.value = hex; }
            };
            colorRgbInput.onkeydown = function (e) {
                if (e.key === "Enter") {
                    e.preventDefault();
                    var hex = setParseRgb(this.value.trim());
                    if (hex) { colorInput.value = hex; colorHexInput.value = hex; this.value = setHexRgb(hex); }
                    else { this.value = setHexRgb(colorInput.value); }
                }
            };
            colorRgbInput.onblur = function () {
                var hex = setParseRgb(this.value.trim());
                if (!hex) { this.value = setHexRgb(colorInput.value); }
            };
        }

        // ====== 预设颜色集交互 ======
        let currentPresets = presetColors.slice(); // 可变的副本
        const presetsContainer = el.querySelector("#setting-presets");
        const refreshPresets = function () {
            // 保留 + 按钮
            const addBtn = presetsContainer.querySelector("#setting-add-preset");
            presetsContainer.innerHTML = buildPresetHtml(currentPresets);
            if (addBtn) presetsContainer.appendChild(addBtn);
            _bindPresetEvents();
        };
        const _bindPresetEvents = function () {
            presetsContainer.querySelectorAll("[data-color]").forEach(function (sw) {
                // 点击色块 → 应用颜色
                sw.onclick = function (e) {
                    if (e.target.getAttribute("data-action") === "del-preset") return;
                    const c = this.getAttribute("data-color");
                    colorInput.value = c;
                    colorHexInput.value = c;
                    colorRgbInput.value = setHexRgb(c);
                };
                // 悬停显示删除按钮
                sw.onmouseenter = function () {
                    const del = this.querySelector('[data-action="del-preset"]');
                    if (del) del.style.display = "";
                };
                sw.onmouseleave = function () {
                    const del = this.querySelector('[data-action="del-preset"]');
                    if (del) del.style.display = "none";
                };
            });
            // 删除按钮
            presetsContainer.querySelectorAll('[data-action="del-preset"]').forEach(function (btn) {
                btn.onclick = function (e) {
                    e.stopPropagation();
                    const idx = parseInt(this.getAttribute("data-idx"));
                    currentPresets.splice(idx, 1);
                    refreshPresets();
                };
            });
        };
        _bindPresetEvents();

        // + 按钮：添加当前取色器颜色到预设
        el.querySelector("#setting-add-preset").onclick = function () {
            const c = colorInput.value;
            if (currentPresets.indexOf(c) >= 0) return; // 不重复添加
            currentPresets.push(c);
            refreshPresets();
        };

        el.querySelector("#setting-save").onclick = function () {
            const cfg = {
                brushSize: parseInt(el.querySelector("#setting-brush-size").value),
                brushColor: el.querySelector("#setting-brush-color").value,
                brushOpacity: parseInt(el.querySelector("#setting-brush-opacity").value),
                highlighterSize: parseInt(el.querySelector("#setting-highlighter-size").value),
                highlighterOpacity: parseInt(el.querySelector("#setting-highlighter-opacity").value),
                autoSave: el.querySelector("#setting-auto-save").checked,
                fingerDoubleTapEnabled: el.querySelector("#setting-finger-doubletap").checked,
                twoFingerUndoEnabled: el.querySelector("#setting-twofinger-undo").checked,
                exportPath: el.querySelector("#setting-export-path").value.trim(),
                presetColors: currentPresets.slice()
            };
            if (self._saveSettings(cfg)) {
                // 立即应用到当前画笔和工具栏
                self._applySettings(cfg);
                // 更新工具栏控件值（如果工具栏正在显示）
                if (self._toolbarEl && document.body.contains(self._toolbarEl)) {
                    const tbColorBtn = self._toolbarEl.querySelector("#dd-color-btn");
                    const tbSize = self._toolbarEl.querySelector("#dd-size");
                    const tbSizeLabel = self._toolbarEl.querySelector("#dd-size-label");
                    if (tbColorBtn) tbColorBtn.style.background = cfg.brushColor;
                    if (tbSize) tbSize.value = cfg.brushSize;
                    if (tbSizeLabel) tbSizeLabel.textContent = cfg.brushSize;
                }
                siyuan.showMessage("✅ 设置已保存", 2000);
            } else {
                siyuan.showMessage("❌ 保存失败", 3000);
            }
        };

        // 不透明度滑块
        var opacitySlider = el.querySelector("#setting-brush-opacity");
        var opacityLabel = el.querySelector("#setting-opacity-label");
        if (opacitySlider) {
            opacitySlider.oninput = function () {
                opacityLabel.textContent = this.value + "%";
            };
        }

        // 荧光笔粗细
        var hlSizeSlider = el.querySelector("#setting-highlighter-size");
        var hlSizeNum = el.querySelector("#setting-highlighter-size-num");
        if (hlSizeSlider && hlSizeNum) {
            hlSizeSlider.oninput = function () { hlSizeNum.value = this.value; };
            hlSizeNum.oninput = function () {
                var v = parseInt(this.value);
                if (isNaN(v) || v < 1) v = 1;
                if (v > 50) v = 50;
                hlSizeSlider.value = v;
            };
            hlSizeNum.onblur = function () {
                var v = parseInt(this.value);
                if (isNaN(v) || v < 1) v = 1;
                if (v > 50) v = 50;
                this.value = v;
                hlSizeSlider.value = v;
            };
        }

        // 荧光笔透明度
        var hlOpacitySlider = el.querySelector("#setting-highlighter-opacity");
        var hlOpacityLabel = el.querySelector("#setting-hl-opacity-label");
        if (hlOpacitySlider) {
            hlOpacitySlider.oninput = function () {
                hlOpacityLabel.textContent = this.value + "%";
            };
        }

        // 画笔大小：range 滑块 ↔ 数字输入框 双向同步
        const sizeSlider = el.querySelector("#setting-brush-size");
        const sizeNum = el.querySelector("#setting-brush-size-num");
        if (sizeSlider && sizeNum) {
            sizeSlider.oninput = function () {
                sizeNum.value = this.value;
            };
            sizeNum.oninput = function () {
                let v = parseInt(this.value);
                if (isNaN(v) || v < 1) v = 1;
                if (v > 50) v = 50;
                sizeSlider.value = v;
            };
            sizeNum.onblur = function () {
                let v = parseInt(this.value);
                if (isNaN(v) || v < 1) v = 1;
                if (v > 50) v = 50;
                this.value = v;
                sizeSlider.value = v;
            };
        }
    }

    // ========== 查看所有图层 ==========
    _showAllLayersDialog() {
        var self = this;
        if (!this._layerManager) this._initManagers();
        if (!this._storage) { siyuan.showMessage("⚠️ 存储未初始化", 2000); return; }

        var loadingHtml = '<div id="all-layers-content" style="padding:16px;min-width:420px;">' +
            '<h3 style="margin:0 0 12px 0;font-size:15px;">🗂️ 所有图层总览</h3>' +
            '<div style="padding:32px;text-align:center;color:#999;">⏳ 正在扫描...</div></div>';

        var dialog = new siyuan.Dialog({ title: "所有图层总览", content: loadingHtml, width: "520px", height: "auto" });
        var el = dialog.element;
        if (!el) return;

        this._storage.listAllDocuments(function (docs) {
            var contentEl = el.querySelector("#all-layers-content");
            if (!contentEl) return;
            if (!docs || docs.length === 0) {
                contentEl.innerHTML = '<h3 style="margin:0 0 12px 0;font-size:15px;">🗂️ 所有图层总览</h3>' +
                    '<div style="padding:32px;text-align:center;color:#999;">暂无任何文档的绘图数据</div>';
                return;
            }
            var totalLayers = 0;
            docs.forEach(function (d) { totalLayers += d.layers.length; });
            docs.sort(function (a, b) { return (a.docTitle || "").localeCompare(b.docTitle || ""); });

            var html = '<h3 style="margin:0 0 8px 0;font-size:15px;">🗂️ 所有图层总览</h3>' +
                '<div style="margin-bottom:10px;font-size:12px;color:#999;">共 ' + docs.length + ' 个文档，' + totalLayers + ' 个图层</div>' +
                '<div id="all-layers-list" style="max-height:440px;overflow-y:auto;">';

            docs.forEach(function (doc, docIdx) {
                var docTitleEsc = (doc.docTitle || doc.docId).replace(/"/g, "&quot;").replace(/</g, "&lt;");
                var layerCount = doc.layers.length;
                var isCurrentDoc = self._docManager && doc.docId === self._docManager.getDocumentID();
                var star = isCurrentDoc ? ' ⭐' : '';
                html += '<div class="all-layers-doc" style="margin-bottom:6px;border:1px solid var(--b3-border-color,#eee);border-radius:8px;overflow:hidden;">' +
                    '<div class="doc-header" style="padding:8px 12px;background:var(--b3-theme-second,#f5f7fa);cursor:pointer;display:flex;align-items:center;gap:6px;user-select:none;" data-doc-idx="' + docIdx + '">' +
                    '<span class="doc-toggle" style="font-size:10px;color:#999;">▶</span>' +
                    '<span style="font-size:14px;">📄</span>' +
                    '<span style="flex:1;font-size:13px;font-weight:600;">' + docTitleEsc + star + '</span>' +
                    '<span style="font-size:11px;color:#999;">' + layerCount + ' 层</span>' +
                    '</div>' +
                    '<div class="doc-layers" data-doc-idx="' + docIdx + '" style="display:none;">';
                if (layerCount === 0) {
                    html += '<div style="padding:8px 12px 8px 32px;font-size:12px;color:#999;">（空）</div>';
                } else {
                    doc.layers.forEach(function (l) {
                        var eye = l.visible !== false ? '👁️' : '🚫';
                        var layerNameEsc = (l.name || "图层 " + l.id).replace(/"/g, "&quot;").replace(/</g, "&lt;");
                        html += '<div class="layer-row" data-doc-idx="' + docIdx + '" data-layer-id="' + l.id + '" style="display:flex;align-items:center;gap:6px;padding:4px 12px 4px 28px;font-size:12px;cursor:pointer;transition:background 0.1s;color:var(--b3-theme-on-background,#555);">' +
                            '<span style="font-size:12px;opacity:0.7;">' + eye + '</span>' +
                            '<span style="flex:1;">' + layerNameEsc + '</span>' +
                            '<span class="jump-hint" style="font-size:10px;color:#ccc;opacity:0;">点击跳转 →</span>' +
                            '</div>';
                    });
                }
                html += '</div></div>';
            });
            html += '</div>';
            contentEl.innerHTML = html;

            // 文档折叠/展开
            var headers = contentEl.querySelectorAll(".doc-header");
            headers.forEach(function (hdr) {
                hdr.onclick = function () {
                    var idx = hdr.getAttribute("data-doc-idx");
                    var layersEl = contentEl.querySelector('[data-doc-idx="' + idx + '"].doc-layers');
                    var toggle = hdr.querySelector(".doc-toggle");
                    if (layersEl) {
                        var isOpen = layersEl.style.display !== "none";
                        layersEl.style.display = isOpen ? "none" : "";
                        if (toggle) toggle.style.transform = isOpen ? "" : "rotate(90deg)";
                    }
                };
            });

            // 图层行 hover 效果 + 点击跳转
            var rows = contentEl.querySelectorAll(".layer-row");
            rows.forEach(function (row) {
                row.onmouseenter = function () { this.style.background = "var(--b3-list-hover, rgba(24,144,255,0.06))"; var h = this.querySelector(".jump-hint"); if (h) h.style.opacity = "1"; };
                row.onmouseleave = function () { this.style.background = ""; var h = this.querySelector(".jump-hint"); if (h) h.style.opacity = "0"; };
                row.onclick = function () {
                    var docIdx2 = parseInt(row.getAttribute("data-doc-idx"));
                    var doc2 = docs[docIdx2];
                    if (!doc2) return;
                    self._navigateToDocument(doc2.docId, doc2.docTitle);
                };
            });
        });
    }

    // ========== UUID → root_id 解析（通过 SQL API） ==========
    // Siyuan v3.7.0 平板端 DOM 中的 data-id / data-node-id 是 UUID 格式，
    // 需要用 SQL 查询 blocks 表找到对应的 root_id（文档唯一标识）
    _resolveUuidToRootId(uuid, docTitle, callback) {
        var self = this;
        var title = (docTitle || "").trim();
        if (!title) { callback(null); return; }

        // 直接 SQL 查出文档 root_id（对 type='d' 块，id 即 root_id）
        var sql = "SELECT id FROM blocks WHERE type = 'd' AND content = '" + title.replace(/'/g, "''") + "' LIMIT 1";
        console.log("[DocumentDrawing] Looking up doc by title:", title);

        var handleSql = function (data) {
            try {
                if (data && data.code === 0 && data.data && data.data.length > 0) {
                    var rootId = data.data[0].id;
                    console.log("[DocumentDrawing] SQL resolved:", title, "→", rootId);
                    callback(rootId);
                } else {
                    // SQL 没找到，尝试 listDocTree
                    console.log("[DocumentDrawing] SQL no match, trying listDocTree...");
                    self._resolveViaListDocTree(title, callback);
                }
            } catch (e) { console.log("[DocumentDrawing] SQL error:", e.message); callback(null); }
        };

        if (typeof _siyuanFetchPost === "function") {
            _siyuanFetchPost("/api/query/sql", { stmt: sql }, handleSql);
        } else {
            try {
                var xhr = new XMLHttpRequest();
                xhr.open("POST", "/api/query/sql", true);
                xhr.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
                xhr.timeout = 5000;
                xhr.onreadystatechange = function () {
                    if (xhr.readyState !== 4) return;
                    try { handleSql(JSON.parse(xhr.responseText)); } catch (e) { callback(null); }
                };
                xhr.ontimeout = function () { callback(null); };
                xhr.onerror = function () { callback(null); };
                xhr.send(JSON.stringify({ stmt: sql }));
            } catch (e) { callback(null); }
        }
    }

    // 备选：通过 listDocTree API 在所有笔记本中搜索文档
    _resolveViaListDocTree(docTitle, callback) {
        var self = this;
        if (typeof _siyuanFetchPost !== "function") { callback(null); return; }

        // 先列出所有笔记本
        _siyuanFetchPost("/api/notebook/lsNotebooks", {}, function (resp) {
            try {
                if (!resp || resp.code !== 0 || !resp.data || !resp.data.notebooks) {
                    callback(null); return;
                }
                var notebooks = resp.data.notebooks;
                var found = false;

                var tryNext = function (idx) {
                    if (idx >= notebooks.length || found) {
                        if (!found) callback(null);
                        return;
                    }
                    var nb = notebooks[idx];
                    _siyuanFetchPost("/api/filetree/listDocTree", {
                        path: "/",
                        notebook: nb.id
                    }, function (treeResp) {
                        if (found) return;
                        if (treeResp && treeResp.code === 0 && treeResp.data) {
                            // 递归搜索树找匹配标题的文档
                            var searchTree = function (nodes) {
                                if (!nodes) return null;
                                for (var i = 0; i < nodes.length; i++) {
                                    if (nodes[i].id && /^\d{14}-[a-z0-9]{7}$/.test(nodes[i].id)) {
                                        // 找到可能的文档 ID，用 getBlockInfo 验证
                                        return nodes[i].id;
                                    }
                                    if (nodes[i].children) {
                                        var child = searchTree(nodes[i].children);
                                        if (child) return child;
                                    }
                                }
                                return null;
                            };
                            // listDocTree 返回的是树结构，叶节点是文档
                            // 我们需要匹配标题，但树里只有 id 没有 title
                            // 所以收集所有文档 ID 然后用 getBlockInfo 验证
                            var collectIds = function (nodes, ids) {
                                if (!nodes) return;
                                for (var i = 0; i < nodes.length; i++) {
                                    if (nodes[i].id && /^\d{14}-[a-z0-9]{7}$/.test(nodes[i].id)) {
                                        ids.push(nodes[i].id);
                                    }
                                    if (nodes[i].children) collectIds(nodes[i].children, ids);
                                }
                            };
                            var allIds = [];
                            collectIds(treeResp.data, allIds);
                            // 对每个 ID 调 getBlockInfo 验证标题
                            var checkIdx = 0;
                            var checkNext = function () {
                                if (checkIdx >= allIds.length || found) {
                                    if (!found) tryNext(idx + 1);
                                    return;
                                }
                                var did = allIds[checkIdx++];
                                _siyuanFetchPost("/api/block/getBlockInfo", { id: did }, function (infoResp) {
                                    if (infoResp && infoResp.code === 0 && infoResp.data) {
                                        var blockContent = infoResp.data.content || "";
                                        if (blockContent === docTitle) {
                                            found = true;
                                            console.log("[DocumentDrawing] listDocTree matched:", docTitle, "→", did);
                                            callback(did);
                                            return;
                                        }
                                    }
                                    checkNext();
                                });
                            };
                            checkNext();
                        } else {
                            tryNext(idx + 1);
                        }
                    });
                };
                tryNext(0);
            } catch (e) { callback(null); }
        });
    }

    // ========== 导航到文档（UUID 自动解析为 root_id） ==========
    _navigateToDocument(docId, docTitle) {
        var self = this;
        // 判断是否为 UUID 格式（需要解析）还是 root_id 格式（可直接使用）
        var isUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(docId);
        var isRootId = /^\d{14}-[a-z0-9]{7}$/.test(docId);

        var doOpen = function (id) {
            try {
                if (self.app && self.app.openTab) {
                    self.app.openTab({ doc: { id: id } });
                } else if (typeof siyuan !== "undefined" && siyuan.openTab) {
                    siyuan.openTab({ doc: { id: id } });
                } else {
                    siyuan.showMessage("📄 请手动搜索: " + (docTitle || id.slice(0, 12)), 4000);
                    return;
                }
                siyuan.showMessage("📄 已跳转到: " + (docTitle || id.slice(0, 12)), 2000);
            } catch (e) {
                siyuan.showMessage("⚠️ 打开文档失败: " + e.message, 3000);
            }
        };

        if (isRootId) {
            doOpen(docId);
        } else if (isUuid) {
            // UUID 格式，通过 SQL 解析为 root_id（同时传标题兜底）
            siyuan.showMessage("🔍 正在定位文档...", 2000);
            this._resolveUuidToRootId(docId, docTitle, function (rootId) {
                if (rootId) {
                    // ★ 解析成功：把 root_id 写回 config，下次直接跳转
                    self._updateDocIdInConfig(docId, rootId);
                    doOpen(rootId);
                } else {
                    siyuan.showMessage("⚠️ 无法解析文档 ID，请直接打开该文档后重新保存图层", 5000);
                }
            });
        } else if (docId.length <= 8) {
            siyuan.showMessage("⚠️ 文档 ID 不完整，请重新打开该文档后保存图层", 4000);
        } else {
            doOpen(docId);
        }
    }

    // 将 config 中的 _docId 从 uuid 更新为 root_id，下次无需 SQL
    _updateDocIdInConfig(uuid, rootId) {
        var self = this;
        if (!this._storage) return;
        this._storage.updateDocId(uuid, rootId, function (updated) {
            if (updated) {
                console.log("[DocumentDrawing] Updated config:", uuid.slice(0, 12) + "…", "→", rootId);
                // ★ 同步更新内存中的 _docId，防止下次 _autoSave 又用 UUID 覆盖
                if (self._docManager && self._docManager._docId === uuid) {
                    self._docManager._docId = rootId;
                }
            }
        });
    }

}

module.exports = DocumentDrawingPlugin;
