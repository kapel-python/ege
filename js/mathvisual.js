/* ============================================================
   MathVisual — declarative math-diagram engine.
   ------------------------------------------------------------
   One goal only: a task's `mathVisual` field is JSON, never JS.
   Adding a diagram to a new task means writing a spec object, not
   a new render function.

     MathVisual.render(container, spec) -> { ok: true } | { ok: false, error }

   `spec.type` selects a template (see TEMPLATES below); each template
   turns declarative `objects` into JSXGraph elements (2D: JXG board,
   3D: JXG View3D) except "probability_tree", which has no natural
   coordinate-plane form and is drawn as plain SVG.

   Every object in `objects` may carry an `id` so later objects can
   refer to it (`from`, `to`, `at`, `vertices`, ...). Unknown types,
   dangling references, non-finite coordinates or an empty/missing
   object list never throw past this module — render() always
   returns a result object, and the container gets a readable
   fallback state instead of a half-built or blank diagram.
   ============================================================ */

(function (global) {
  "use strict";

  // ---------------------------------------------------------------
  // Engine-wide interaction lock.
  //
  // The rule for every MathVisual diagram: the camera may move, the
  // figure never does. Every builder below already creates its own
  // points/lines/circles/polygons with `fixed: true`, but JSXGraph's
  // 3D module also manufactures its own internal helper points behind
  // the scenes (e.g. a 2D projection point per point3d per edge, used
  // only to draw a line3d on the underlying SVG board) that never go
  // through any of those builders and so never get their own `fixed`.
  // Patching the *type defaults* here -- once, before any board exists
  // -- closes that class of loophole centrally instead of chasing it
  // call site by call site, and also protects any future object type
  // this module doesn't build yet. `view3d` itself is deliberately left
  // alone: it is the camera, and rotate/zoom is exactly the interaction
  // this file wants to keep.
  if (typeof JXG !== "undefined" && JXG.Options) {
    const LOCKED_TYPES = ["point", "point3d", "line", "line3d", "circle", "sphere3d",
      "polygon", "polygon3d", "curve", "angle", "nonreflexangle", "glider"];
    for (const key of LOCKED_TYPES) {
      if (JXG.Options[key]) JXG.Options[key].fixed = true;
    }
  }

  let boardCounter = 0;

  function theme() {
    const css = getComputedStyle(document.documentElement);
    const get = (name, fallback) => (css.getPropertyValue(name) || "").trim() || fallback;
    return {
      text: get("--text", "#1f2430"),
      muted: get("--muted", "#7a8194"),
      border: get("--border-strong", "#c7cbd6"),
      accent: get("--accent", "#6d7cff"),
      violet: get("--violet", "#9a7bff"),
      success: get("--success", "#3ddc97"),
      danger: get("--danger", "#ff6b6b"),
      warn: get("--warn", "#ffb44b"),
      grid: get("--border", "rgba(127,127,127,0.18)"),
      bg: "transparent",
    };
  }

  const PALETTE_ORDER = ["accent", "violet", "success", "danger", "warn"];
  function colorFor(t, index) {
    return t[PALETTE_ORDER[index % PALETTE_ORDER.length]];
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function isFiniteNum(v) {
    return typeof v === "number" && Number.isFinite(v);
  }

  class VisualError extends Error {}

  function renderFallback(container, message) {
    container.innerHTML = "";
    container.className = "task-visual task-visual--missing mathvisual-host";
    const div = document.createElement("div");
    div.className = "task-visual__fallback";
    div.style.display = "block";
    div.setAttribute("role", "status");
    div.textContent = "Не удалось построить рисунок" + (message ? ": " + message : ".");
    container.appendChild(div);
  }

  /* ---------------- shared 2D board helpers ---------------- */

  // Raw [x, y] pairs passed straight to board.create() make JSXGraph
  // manufacture implicit endpoint points -- those default to draggable
  // regardless of the line/segment's own `fixed`, so every implicit
  // endpoint anywhere in this module is locked explicitly via point1/point2.
  const LOCKED_ENDPOINT = { fixed: true, highlight: false, visible: false, withLabel: false, name: "" };

  function autoBoundingBox(points, padRatio) {
    if (!points.length) return [-5, 5, 5, -5];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of points) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const spanX = Math.max(maxX - minX, 2);
    const spanY = Math.max(maxY - minY, 2);
    const pad = Math.max(spanX, spanY) * (padRatio == null ? 0.25 : padRatio);
    return [minX - pad, maxY + pad, maxX + pad, minY - pad];
  }

  function makeBoard(container, spec, t, extraPoints) {
    const el = document.createElement("div");
    el.id = "mv-board-" + (++boardCounter);
    el.className = "mathvisual-board";
    container.appendChild(el);

    const boundingbox = Array.isArray(spec.boundingBox) && spec.boundingBox.length === 4
      ? spec.boundingBox
      : autoBoundingBox(extraPoints || [], spec.padding);

    if (boundingbox.some((v) => !isFiniteNum(v))) throw new VisualError("некорректная область координат");

    // Interactivity policy is per figure kind, not a blanket "camera is
    // always free": a flat geometric figure (triangle/quadrilateral/polygon/
    // circle_geometry -- illustrating a fixed set of measurements) gets no
    // camera control at all, not even zoom, since there is nothing useful to
    // frame differently. A coordinate/graph-style board (`spec.axis` is the
    // exact flag TEMPLATES already uses to mark coordinate_geometry,
    // vector_diagram, function_graph, derivative_graph) is read by scale, so
    // it gets zoom in/out and nothing more -- no pan, no rotate (it has none
    // to give). 3D solids don't go through this function at all; their own
    // board in render3D() is the one place rotate is offered.
    const allowZoom = !!spec.axis;

    const board = JXG.JSXGraph.initBoard(el.id, {
      boundingbox,
      keepAspectRatio: spec.keepAspectRatio !== false,
      axis: false,
      showNavigation: false,
      showCopyright: false,
      showInfobox: false, // координатная табличка при нажатии/удержании точки — лишний артефакт на статичной фигуре
      // Every math object below is built `fixed: true`, so even where zoom
      // is on, there is nothing a drag can move but the camera.
      pan: { enabled: false },
      zoom: { enabled: allowZoom, wheel: true, pinch: true, needShift: false },
      resize: { enabled: true, throttle: 80 },
      renderer: "svg",
    });

    if (spec.grid !== false && spec.type !== "triangle" && spec.type !== "quadrilateral" &&
        spec.type !== "polygon" && spec.type !== "circle_geometry") {
      board.create("grid", [], { strokeColor: t.grid, strokeWidth: 1, strokeOpacity: 1 });
    }
    if (spec.axis) {
      // Same raw-coordinate trap as everywhere else: axis's own [0,0]/[1,0]
      // endpoints must not become implicit free (draggable) points.
      const axisAttr = {
        strokeColor: t.muted, strokeWidth: 1.4, fixed: true, highlight: false,
        point1: LOCKED_ENDPOINT, point2: LOCKED_ENDPOINT,
        ticks: { strokeColor: t.muted, majorHeight: 6, minorTicks: 0, label: { strokeColor: t.muted, fontSize: 12 } },
      };
      board.create("axis", [[0, 0], [1, 0]], axisAttr);
      board.create("axis", [[0, 0], [0, 1]], axisAttr);
    }
    return board;
  }

  /* Resolve a point-like reference: an id string (looked up in the registry),
     a [x, y] pair, or a JSXGraph element already created.

     A raw [x, y] pair must NEVER be handed straight to board.create() for a
     segment/circle/polygon/etc. -- JSXGraph silently manufactures an implicit
     free point for it, and a free point is draggable by default, i.e. it is
     a back door around every `fixed: true` on the declared points. Instead
     we create that point ourselves, locked down the same way buildPoint()
     locks down a declared one. */
  function resolvePoint(ref, registry, board) {
    if (ref == null) throw new VisualError("отсутствует ссылка на точку");
    if (typeof ref === "string") {
      const found = registry[ref];
      if (!found) throw new VisualError(`неизвестная точка "${ref}"`);
      return found;
    }
    if (Array.isArray(ref) && ref.length === 2 && isFiniteNum(ref[0]) && isFiniteNum(ref[1])) {
      if (!board) throw new VisualError("некорректная точка");
      return board.create("point", ref, { fixed: true, highlight: false, visible: false, withLabel: false, name: "" });
    }
    if (ref && typeof ref === "object" && typeof ref.X === "function") return ref;
    throw new VisualError("некорректная точка");
  }

  function styleFor(t, obj, index, defaults) {
    const color = obj.color ? (t[obj.color] || obj.color) : colorFor(t, index != null ? index : 0);
    return Object.assign({ strokeColor: color, fillColor: color }, defaults || {});
  }

  /* ---------------- primitive builders (2D) ---------------- */

  function buildPoint(board, registry, obj, t, i) {
    if (!isFiniteNum(obj.x) || !isFiniteNum(obj.y)) throw new VisualError(`точка "${obj.id || obj.label || "?"}" имеет некорректные координаты`);
    const p = board.create("point", [obj.x, obj.y], {
      name: obj.label != null ? obj.label : (obj.id || ""),
      size: obj.size || 3,
      strokeColor: t.text,
      fillColor: obj.hidden ? "none" : (obj.color ? (t[obj.color] || obj.color) : t.text),
      strokeWidth: 1.4,
      fixed: true,
      highlight: false,
      withLabel: obj.label !== false,
      label: { fontSize: 15, strokeColor: t.text, offset: obj.labelOffset || [8, 8], cssClass: "mathvisual-label", highlightCssClass: "mathvisual-label" },
      visible: !obj.hidden,
    });
    if (obj.id) registry[obj.id] = p;
    return p;
  }

  function buildMidpoint(board, registry, obj, t) {
    const [a, b] = (obj.of || []).map((r) => resolvePoint(r, registry, board));
    if (!a || !b) throw new VisualError("midpoint требует двух точек в `of`");
    const p = board.create("midpoint", [a, b], {
      name: obj.label != null ? obj.label : (obj.id || ""), size: obj.size || 3, strokeColor: t.text,
      fillColor: t.text, fixed: true, highlight: false, withLabel: obj.label !== false,
      label: { fontSize: 15, strokeColor: t.text, offset: [8, 8] },
    });
    if (obj.id) registry[obj.id] = p;
    return p;
  }

  function buildFoot(board, registry, obj, t) {
    // perpendicular foot from `from` onto the line through `to[0]`-`to[1]`
    const from = resolvePoint(obj.from, registry, board);
    const [b1, b2] = (obj.to || []).map((r) => resolvePoint(r, registry, board));
    if (!from || !b1 || !b2) throw new VisualError("perpendicular_foot требует `from` и `to: [id, id]`");
    const line = board.create("line", [b1, b2], { visible: false, fixed: true, highlight: false });
    const foot = board.create("orthogonalprojection", [from, line], {
      name: obj.label != null ? obj.label : (obj.id || ""), size: 2, strokeColor: t.muted, fillColor: t.muted,
      fixed: true, highlight: false, withLabel: !!obj.label, label: { fontSize: 13, strokeColor: t.muted },
    });
    if (obj.id) registry[obj.id] = foot;
    return foot;
  }

  function buildSegmentLike(board, registry, obj, t, i, kind) {
    const from = resolvePoint(obj.from, registry, board);
    const to = resolvePoint(obj.to, registry, board);
    const style = styleFor(t, obj, i, { strokeWidth: obj.width || 2.4, dash: obj.dashed ? 2 : 0, fixed: true, highlight: false });
    const jxType = kind === "ray" ? "arrow" : kind === "line" ? "line" : kind === "vector" ? "arrow" : "segment";
    const attrs = Object.assign({}, style);
    if (kind === "line") { attrs.straightFirst = true; attrs.straightLast = true; }
    if (kind === "ray") { attrs.straightFirst = false; attrs.straightLast = true; }
    const el = board.create(jxType, [from, to], attrs);
    if (obj.label) {
      board.create("text", [() => (from.X() + to.X()) / 2 + (obj.labelOffset ? obj.labelOffset[0] / 40 : 0),
                             () => (from.Y() + to.Y()) / 2 + (obj.labelOffset ? obj.labelOffset[1] / 40 : 0.25),
                             obj.label], { fontSize: 13, color: t.muted, cssClass: "mathvisual-label" });
    }
    if (obj.id) registry[obj.id] = el;
    return el;
  }

  function buildCircle(board, registry, obj, t, i) {
    const style = styleFor(t, obj, i, { strokeWidth: 2.2, fillOpacity: obj.fill ? 0.08 : 0, dash: obj.dashed ? 2 : 0, fixed: true, highlight: false });
    let el;
    if (obj.through) {
      const center = resolvePoint(obj.center, registry, board);
      const through = resolvePoint(obj.through, registry, board);
      el = board.create("circle", [center, through], style);
    } else if (isFiniteNum(obj.radius)) {
      const center = resolvePoint(obj.center, registry, board);
      el = board.create("circle", [center, obj.radius], style);
    } else {
      throw new VisualError("circle требует `radius` или `through`");
    }
    if (obj.id) registry[obj.id] = el;
    return el;
  }

  function buildEllipse(board, registry, obj, t, i) {
    // Цилиндры и другие тела вращения в боковой проекции: контур эллипса
    // параметрической кривой (JSXGraph `curve`), без свободных точек.
    if (!Array.isArray(obj.center) || obj.center.length !== 2 || !obj.center.every(isFiniteNum)) {
      throw new VisualError("ellipse требует числовой центр");
    }
    if (!isFiniteNum(obj.rx) || obj.rx <= 0 || !isFiniteNum(obj.ry) || obj.ry <= 0) {
      throw new VisualError("ellipse требует положительные rx и ry");
    }
    const [cx, cy] = obj.center;
    const style = styleFor(t, obj, i, { strokeWidth: 2.2, fillOpacity: 0, fillColor: "none", dash: obj.dashed ? 2 : 0, fixed: true, highlight: false });
    const el = board.create("curve", [
      (tt) => cx + obj.rx * Math.cos(tt),
      (tt) => cy + obj.ry * Math.sin(tt),
      0, Math.PI * 2,
    ], style);
    if (obj.id) registry[obj.id] = el;
    return el;
  }

  function buildPolygon(board, registry, obj, t, i) {
    const vertices = (obj.vertices || []).map((r) => resolvePoint(r, registry, board));
    if (vertices.length < 3) throw new VisualError("polygon требует минимум 3 вершины");
    const style = styleFor(t, obj, i, {
      strokeWidth: 2.2, fillOpacity: obj.fill === false ? 0 : 0.06,
      // The polygon body itself must not be draggable (dragging the fill
      // normally translates all its vertices at once), on top of every
      // vertex already being individually fixed.
      fixed: true, highlight: false, hasInnerPoints: false,
      vertices: { visible: false, fixed: true },
      borders: { fixed: true, highlight: false },
    });
    const el = board.create("polygon", vertices, style);
    if (obj.id) registry[obj.id] = el;
    return el;
  }

  function buildAngleMark(board, registry, obj, t) {
    const vertex = resolvePoint(obj.vertex, registry, board);
    const from = resolvePoint(obj.from, registry, board);
    const to = resolvePoint(obj.to, registry, board);
    board.create("angle", [from, vertex, to], {
      radius: obj.radius || 0.6, strokeColor: t.muted, fillColor: t.muted, fillOpacity: 0.12,
      name: obj.label || "", withLabel: !!obj.label, label: { fontSize: 13, strokeColor: t.text },
      // The arc has its own draggable radius point by default -- dragging it
      // only changes the mark's drawn size, but that is still an edit to the
      // figure, so it stays locked like every other object.
      fixed: true, highlight: false, radiuspoint: { visible: false, fixed: true },
    });
  }

  function buildRightAngleMark(board, registry, obj, t) {
    const vertex = resolvePoint(obj.at, registry, board);
    const from = resolvePoint(obj.from, registry, board);
    const to = resolvePoint(obj.to, registry, board);
    board.create("nonreflexangle", [from, vertex, to], {
      radius: obj.radius || 0.45, strokeColor: t.muted, fillColor: "none", type: "square",
      // angle elements auto-name themselves (Greek letters) and show that
      // label by default -- a right-angle tick mark should never carry one.
      name: "", withLabel: false,
      fixed: true, highlight: false, radiuspoint: { visible: false, fixed: true },
    });
  }

  function buildLabel(board, obj, t) {
    if (!isFiniteNum(obj.x) || !isFiniteNum(obj.y)) throw new VisualError("label требует числовых x/y");
    board.create("text", [obj.x, obj.y, obj.text || ""], { fontSize: 13, color: t.text, cssClass: "mathvisual-label" });
  }

  /* ---- function graphs (linear/quadratic/power/exponential/logarithmic/custom) ---- */

  function compileFunction(board, def) {
    if (typeof def.expr === "string") {
      // JessieCode's safe snippet evaluator -- never raw eval().
      return board.jc.snippet(def.expr, true, "x", true);
    }
    const p = def.params || {};
    switch (def.kind) {
      case "linear": return (x) => (p.k != null ? p.k : 1) * x + (p.b || 0);
      case "quadratic": return (x) => (p.a != null ? p.a : 1) * x * x + (p.b || 0) * x + (p.c || 0);
      case "power": return (x) => (p.k != null ? p.k : 1) / x;
      case "exponential": return (x) => (p.a != null ? p.a : 1) * Math.pow(p.base != null ? p.base : Math.E, x);
      case "logarithmic": return (x) => (p.a != null ? p.a : 1) * (Math.log(x) / Math.log(p.base != null ? p.base : Math.E));
      default: throw new VisualError(`неизвестный вид функции "${def.kind}"`);
    }
  }

  function buildFunctionGraph(board, registry, obj, t, i) {
    const fn = compileFunction(board, obj);
    const domain = Array.isArray(obj.domain) ? obj.domain : undefined;
    // A function graph is a curve, not a fillable region -- fillOpacity must
    // be explicit 0, otherwise JSXGraph shades the whole area under it.
    const style = styleFor(t, obj, i, { strokeWidth: 2.6, fillOpacity: 0, fillColor: "none", fixed: true, highlight: false });
    const args = domain ? [fn, domain[0], domain[1]] : [fn];
    const el = board.create("functiongraph", args, style);
    if (obj.id) registry[obj.id] = { fn, el };
    return { fn, el };
  }

  function buildMarkedPoint(board, registry, obj, t) {
    const of = registry[obj.on];
    if (!of || !of.fn) throw new VisualError(`marked_point ссылается на неизвестную функцию "${obj.on}"`);
    if (!isFiniteNum(obj.x)) throw new VisualError("marked_point требует числового x");
    const y = of.fn(obj.x);
    const p = board.create("point", [obj.x, y], {
      name: obj.label || "", size: 3, strokeColor: t.text, fillColor: t.text, fixed: true, highlight: false,
      withLabel: !!obj.label, label: { fontSize: 13, offset: [8, 8] },
    });
    if (obj.id) registry[obj.id] = p;
    return p;
  }

  function buildTangent(board, registry, obj, t) {
    const of = registry[obj.on];
    if (!of || !of.fn) throw new VisualError(`tangent ссылается на неизвестную функцию "${obj.on}"`);
    const glider = board.create("glider", [obj.x, of.fn(obj.x), of.el], { visible: false, fixed: true });
    board.create("tangent", [glider], { strokeColor: t.muted, strokeWidth: 2, dash: 1, fixed: true, highlight: false });
  }

  function buildAsymptote(board, obj, t) {
    const attrs = { strokeColor: t.muted, dash: 2, strokeWidth: 1.4, fixed: true, highlight: false, point1: LOCKED_ENDPOINT, point2: LOCKED_ENDPOINT };
    if (obj.axis === "x") board.create("line", [[0, obj.value || 0], [1, obj.value || 0]], attrs);
    else board.create("line", [[obj.value || 0, 0], [obj.value || 0, 1]], attrs);
  }

  function buildInterval(board, obj, t) {
    if (!isFiniteNum(obj.from) || !isFiniteNum(obj.to)) throw new VisualError("interval требует числовых `from`/`to`");
    const y = obj.y || 0;
    board.create("segment", [[obj.from, y], [obj.to, y]], {
      strokeColor: colorFor(t, 2), strokeWidth: 4, fixed: true, highlight: false,
      point1: LOCKED_ENDPOINT, point2: LOCKED_ENDPOINT,
    });
    for (const [x, open] of [[obj.from, obj.openFrom], [obj.to, obj.openTo]]) {
      board.create("point", [x, y], { size: 3, strokeColor: colorFor(t, 2), fillColor: open ? "#fff" : colorFor(t, 2), fixed: true, highlight: false, withLabel: false });
    }
  }

  /* ---------------- object dispatch (2D) ---------------- */

  function applyObject(board, registry, obj, t, i) {
    if (!obj || typeof obj !== "object" || !obj.type) throw new VisualError("объект без `type`");
    switch (obj.type) {
      case "point": return buildPoint(board, registry, obj, t, i);
      case "midpoint": return buildMidpoint(board, registry, obj, t);
      case "perpendicular_foot": return buildFoot(board, registry, obj, t);
      case "segment": case "altitude": case "median": case "midline": case "bisector":
        return buildSegmentLike(board, registry, obj, t, i, "segment");
      case "ray": return buildSegmentLike(board, registry, obj, t, i, "ray");
      case "line": return buildSegmentLike(board, registry, obj, t, i, "line");
      case "vector": return buildSegmentLike(board, registry, obj, t, i, "vector");
      case "circle": return buildCircle(board, registry, obj, t, i);
      case "ellipse": return buildEllipse(board, registry, obj, t, i);
      case "polygon": return buildPolygon(board, registry, obj, t, i);
      case "angle_mark": return buildAngleMark(board, registry, obj, t);
      case "right_angle_mark": return buildRightAngleMark(board, registry, obj, t);
      case "label": return buildLabel(board, obj, t);
      case "function": return buildFunctionGraph(board, registry, obj, t, i);
      case "marked_point": return buildMarkedPoint(board, registry, obj, t);
      case "tangent": return buildTangent(board, registry, obj, t);
      case "asymptote": return buildAsymptote(board, obj, t);
      case "interval": return buildInterval(board, obj, t);
      default: throw new VisualError(`неизвестный тип объекта "${obj.type}"`);
    }
  }

  function collectPointHints(objects) {
    const pts = [];
    for (const o of objects || []) {
      if (o && o.type === "point" && isFiniteNum(o.x) && isFiniteNum(o.y)) pts.push([o.x, o.y]);
      if (o && o.type === "function" && Array.isArray(o.domain)) { pts.push([o.domain[0], 0], [o.domain[1], 0]); }
    }
    if (!pts.length) pts.push([-3, -3], [3, 3]);
    return pts;
  }

  /* ---------------- generic 2D template (covers coordinate_geometry,
     vector_diagram, function_graph, derivative_graph, triangle,
     quadrilateral, polygon, circle_geometry) ---------------- */

  function render2D(container, spec, t) {
    if (!Array.isArray(spec.objects) || spec.objects.length === 0) throw new VisualError("пустой список объектов");
    const board = makeBoard(container, spec, t, collectPointHints(spec.objects));
    const registry = {};
    // Two passes: points/functions first (so later segments/marks can resolve ids
    // regardless of declaration order), then everything else.
    const firstPass = spec.objects.filter((o) => o && (o.type === "point" || o.type === "function"));
    const rest = spec.objects.filter((o) => !firstPass.includes(o));
    let i = 0;
    for (const obj of firstPass) applyObject(board, registry, obj, t, i++);
    for (const obj of rest) applyObject(board, registry, obj, t, i++);
    return board;
  }

  /* ---------------- 3D solids (box, prism, regular pyramid, regular tetrahedron) ---------------- */

  const SOLID_SHAPES = ["box", "prism", "pyramid", "tetrahedron"];

  function solidVertices(shape, spec) {
    if (shape === "box" || shape === "prism") {
      const dims = spec.dimensions;
      if (!Array.isArray(dims) || dims.some((d) => !isFiniteNum(d) || d <= 0)) {
        throw new VisualError("3d_solid требует положительные числовые `dimensions`");
      }
      const [lx, ly, lz] = dims;
      let baseCoords;
      if (shape === "box") baseCoords = [[0, 0, 0], [lx, 0, 0], [lx, ly, 0], [0, ly, 0]];
      else baseCoords = [[0, 0, 0], [lx, 0, 0], [0, ly, 0]]; // right-triangle base legs lx, ly
      const topCoords = baseCoords.map(([x, y]) => [x, y, lz]);
      return { vertices: baseCoords.concat(topCoords), baseCount: baseCoords.length, apexIndex: -1, extent: Math.max(lx, ly, lz) };
    }
    if (shape === "pyramid") {
      const sides = spec.baseSides;
      const edge = spec.baseEdge;
      const height = spec.height;
      if (!Number.isInteger(sides) || sides < 3) throw new VisualError("pyramid требует целое `baseSides` >= 3");
      if (!isFiniteNum(edge) || edge <= 0) throw new VisualError("pyramid требует положительное `baseEdge`");
      if (!isFiniteNum(height) || height <= 0) throw new VisualError("pyramid требует положительное `height`");
      const R = edge / (2 * Math.sin(Math.PI / sides)); // circumradius of a regular N-gon with this side
      const base = [];
      for (let k = 0; k < sides; k++) {
        const a = (2 * Math.PI * k) / sides;
        base.push([R * Math.cos(a), R * Math.sin(a), 0]);
      }
      const apex = [0, 0, height];
      return { vertices: base.concat([apex]), baseCount: sides, apexIndex: sides, extent: Math.max(R, height) };
    }
    if (shape === "tetrahedron") {
      const edge = spec.edge;
      if (!isFiniteNum(edge) || edge <= 0) throw new VisualError("tetrahedron требует положительное `edge`");
      const base = [[0, 0, 0], [edge, 0, 0], [edge / 2, (edge * Math.sqrt(3)) / 2, 0]];
      const centroid = [edge / 2, (edge * Math.sqrt(3)) / 6, 0];
      const apexHeight = edge * Math.sqrt(2 / 3);
      const apex = [centroid[0], centroid[1], apexHeight];
      return { vertices: base.concat([apex]), baseCount: 3, apexIndex: 3, extent: Math.max(edge, apexHeight) };
    }
    throw new VisualError(`3d_solid поддерживает только ${SOLID_SHAPES.map((s) => `"${s}"`).join(", ")}, получено "${shape}"`);
  }

  // Same rule as the 2D resolvePoint(): never hand a raw [x, y, z] triple to
  // view.create() -- JSXGraph would manufacture an implicit, draggable-by-
  // default point3d for it. `registry` must hold the real point3d elements
  // (not their coordinates) so a labeled reference reuses the same locked
  // point instead of spawning a second, free one at the same spot.
  function resolve3dPoint(ref, registry, view) {
    if (typeof ref === "string") {
      const p = registry[ref];
      if (!p) throw new VisualError(`не найдена 3D-точка "${ref}"`);
      return p;
    }
    if (Array.isArray(ref) && ref.length === 3 && ref.every(isFiniteNum)) {
      if (!view) throw new VisualError("некорректная 3D-точка");
      return view.create("point3d", ref, { fixed: true, highlight: false, visible: false, withLabel: false, name: "" });
    }
    throw new VisualError("некорректная 3D-точка (ожидались координаты [x,y,z] или ссылка на подписанную вершину)");
  }

  function render3D(container, spec, t) {
    const shape = spec.shape;
    if (SOLID_SHAPES.indexOf(shape) === -1) {
      throw new VisualError(`3d_solid поддерживает только ${SOLID_SHAPES.map((s) => `"${s}"`).join(", ")}, получено "${shape}"`);
    }
    const { vertices, baseCount, apexIndex, extent: solidExtent } = solidVertices(shape, spec);
    // The view3d cube must actually contain the solid -- sizing it from a
    // fixed default regardless of dimensions/edge/height is what left large
    // solids clipped almost entirely out of view.
    const extent = solidExtent * 1.2;

    const el = document.createElement("div");
    el.id = "mv-board-" + (++boardCounter);
    el.className = "mathvisual-board";
    container.appendChild(el);
    const board = JXG.JSXGraph.initBoard(el.id, {
      boundingbox: [-6, 6, 6, -6], axis: false, showNavigation: false, showCopyright: false, showInfobox: false,
      // Rotating the solid (az/el drag on the view3d itself, enabled by
      // default below) and zooming are the only view-only controls that make
      // sense for a 3D figure -- board pan would fight the same plain-drag
      // gesture used for rotation, so it stays off; zoom (wheel/pinch) does
      // not conflict and is enabled.
      pan: { enabled: false }, zoom: { enabled: true, wheel: true, pinch: true, needShift: false },
      resize: { enabled: true, throttle: 80 },
    });
    // Parallel (axonometric) projection reads as a normal textbook solid-
    // geometry drawing; JSXGraph's "central" (perspective) default instead
    // produces vanishing-point distortion that made unequal edges look
    // sheared and confusing.
    const view = board.create("view3d", [[-5, -4], [9.5, 9],
      [[-extent * 0.6, extent], [-extent * 0.6, extent], [0, extent]]],
      { projection: "parallel", depthOrder: { enabled: true },
        xPlaneRear: { visible: false }, yPlaneRear: { visible: false }, zPlaneRear: { visible: false },
        xPlaneFront: { visible: false }, yPlaneFront: { visible: false }, zPlaneFront: { visible: false },
        // The auto-created coordinate axes are a debugging aid, not part of a
        // textbook solid-geometry drawing -- hide them for a clean figure.
        xAxis: { visible: false }, yAxis: { visible: false }, zAxis: { visible: false } });

    const labels = Array.isArray(spec.labels) ? spec.labels : [];
    const registry = {};
    const makePt = (coords, idx) => {
      const p = view.create("point3d", coords, {
        name: labels[idx] || "", size: 2, strokeColor: t.text, fillColor: t.text,
        withLabel: !!labels[idx], label: { fontSize: 14, strokeColor: t.text },
        // Vertices are the figure's math, not a control -- only camera
        // rotate/zoom on the view itself may change how the solid looks.
        fixed: true, highlight: false,
      });
      if (labels[idx]) registry[labels[idx]] = p;
      return p;
    };
    const edge = (a, b, dashed, color) => view.create("line3d", [a, b], {
      straightFirst: false, straightLast: false, strokeColor: dashed ? t.muted : (color || t.text),
      strokeWidth: 2, dash: dashed ? 2 : 0, fixed: true, highlight: false,
    });

    const pts = vertices.map((c, idx) => makePt(c, idx));
    const base = pts.slice(0, baseCount);
    for (let k = 0; k < base.length; k++) edge(base[k], base[(k + 1) % base.length], false);
    if (apexIndex >= 0) {
      const apex = pts[apexIndex];
      for (let k = 0; k < base.length; k++) edge(base[k], apex, k >= Math.ceil(base.length / 2));
      view.create("polygon3d", base, { fillOpacity: 0.06, fillColor: t.accent, borders: { visible: false }, fixed: true, highlight: false });
    } else {
      const top = pts.slice(baseCount);
      for (let k = 0; k < top.length; k++) {
        edge(top[k], top[(k + 1) % top.length], false);
        edge(base[k], top[k], k >= Math.ceil(base.length / 2)); // back verticals dashed, front solid
      }
      view.create("polygon3d", base, { fillOpacity: 0.06, fillColor: t.accent, borders: { visible: false }, fixed: true, highlight: false });
    }

    // Additional labeled points (midpoints, section-plane vertices, ...)
    // referenced by extraEdges/sectionPolygon below, or given as raw [x,y,z].
    if (Array.isArray(spec.extraPoints)) {
      for (const ep of spec.extraPoints) {
        if (!Array.isArray(ep.coords) || ep.coords.length !== 3 || !ep.coords.every(isFiniteNum)) {
          throw new VisualError(`extraPoints: точка "${ep.label || "?"}" имеет некорректные координаты`);
        }
        const p = view.create("point3d", ep.coords, {
          name: ep.label || "", size: 2, strokeColor: t.text, fillColor: t.text,
          withLabel: !!ep.label, label: { fontSize: 14, strokeColor: t.text, offset: [6, 6] },
          fixed: true, highlight: false,
        });
        if (ep.label) registry[ep.label] = p;
      }
    }
    if (Array.isArray(spec.extraEdges)) {
      for (const ee of spec.extraEdges) {
        const a = resolve3dPoint(ee.from, registry, view);
        const b = resolve3dPoint(ee.to, registry, view);
        edge(a, b, !!ee.dashed, ee.color ? (t[ee.color] || ee.color) : t.accent);
      }
    }
    if (spec.sectionPolygon && Array.isArray(spec.sectionPolygon.vertices)) {
      const verts = spec.sectionPolygon.vertices.map((v) => resolve3dPoint(v, registry, view));
      if (verts.length < 3) throw new VisualError("sectionPolygon требует минимум 3 вершины");
      const fillColor = spec.sectionPolygon.color ? (t[spec.sectionPolygon.color] || spec.sectionPolygon.color) : t.violet;
      view.create("polygon3d", verts, {
        fillOpacity: spec.sectionPolygon.opacity != null ? spec.sectionPolygon.opacity : 0.16,
        fillColor, borders: { strokeColor: fillColor, strokeWidth: 1.6, dash: 0 },
        fixed: true, highlight: false,
        // Raw [x,y,z] vertices make polygon3d create its own implicit
        // point3d for each corner -- left labeled, they duplicate (and
        // visually collide with) the named extraPoints at the same spot.
        vertices: { visible: false, withLabel: false },
      });
    }
    return board;
  }

  /* ---------------- probability tree (plain SVG, not a coordinate plane) ---------------- */

  function renderProbabilityTree(container, spec, t) {
    const nodes = spec.nodes;
    if (!Array.isArray(nodes) || !nodes.length) throw new VisualError("probability_tree требует `nodes`");
    const byId = {};
    for (const n of nodes) { if (!n || !n.id) throw new VisualError("узел дерева без id"); byId[n.id] = n; }
    const roots = nodes.filter((n) => !n.parent);
    if (!roots.length) throw new VisualError("не найден корень дерева (узел без `parent`)");
    for (const n of nodes) if (n.parent && !byId[n.parent]) throw new VisualError(`узел "${n.id}" ссылается на несуществующего родителя "${n.parent}"`);

    const childrenOf = {};
    for (const n of nodes) if (n.parent) (childrenOf[n.parent] = childrenOf[n.parent] || []).push(n);

    let maxDepth = 0;
    const depthOf = {};
    (function walk(id, d) { depthOf[id] = d; maxDepth = Math.max(maxDepth, d); (childrenOf[id] || []).forEach((c) => walk(c.id, d + 1)); })(roots[0].id, 0);

    const leaves = [];
    (function collect(id) { const kids = childrenOf[id]; if (!kids || !kids.length) leaves.push(id); else kids.forEach((c) => collect(c.id)); })(roots[0].id);

    const W = 640, rowH = 90, H = Math.max(220, (maxDepth + 1) * rowH + 40);
    const xOf = {}, leafGap = W / (leaves.length + 1);
    leaves.forEach((id, i) => { xOf[id] = leafGap * (i + 1); });
    (function assignX(id) {
      const kids = childrenOf[id];
      if (kids && kids.length) { kids.forEach((c) => assignX(c.id)); xOf[id] = kids.reduce((s, c) => s + xOf[c.id], 0) / kids.length; }
    })(roots[0].id);
    const yOf = (id) => 30 + depthOf[id] * rowH;

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Дерево вероятностей" style="width:100%;height:auto;display:block">`;
    for (const n of nodes) {
      if (n.parent) {
        const p = byId[n.parent];
        const x1 = xOf[p.id], y1 = yOf(p.id) + 10, x2 = xOf[n.id], y2 = yOf(n.id) - 10;
        svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${t.muted}" stroke-width="1.6"/>`;
        if (n.probability != null) {
          svg += `<text x="${(x1 + x2) / 2 + 6}" y="${(y1 + y2) / 2}" font-size="12" fill="${t.text}">${esc(n.probability)}</text>`;
        }
      }
    }
    for (const n of nodes) {
      const x = xOf[n.id], y = yOf(n.id);
      svg += `<circle cx="${x}" cy="${y}" r="5" fill="${t.text}"/>`;
      svg += `<text x="${x}" y="${y - 12}" font-size="13" fill="${t.text}" text-anchor="middle">${esc(n.label || "")}</text>`;
    }
    svg += "</svg>";
    container.innerHTML = svg;
    container.className = "task-visual task-visual--geometry mathvisual-host mathvisual-svg";
  }

  /* ---------------- templates ---------------- */

  const TEMPLATES = {
    coordinate_geometry: (c, s, t) => render2D(c, Object.assign({ grid: true, axis: true }, s), t),
    vector_diagram: (c, s, t) => render2D(c, Object.assign({ grid: true, axis: true }, s), t),
    function_graph: (c, s, t) => render2D(c, Object.assign({ grid: true, axis: true }, s), t),
    derivative_graph: (c, s, t) => render2D(c, Object.assign({ grid: true, axis: true }, s), t),
    triangle: (c, s, t) => render2D(c, Object.assign({ grid: false, axis: false }, s), t),
    quadrilateral: (c, s, t) => render2D(c, Object.assign({ grid: false, axis: false }, s), t),
    polygon: (c, s, t) => render2D(c, Object.assign({ grid: false, axis: false }, s), t),
    circle_geometry: (c, s, t) => render2D(c, Object.assign({ grid: false, axis: false }, s), t),
    "3d_solid": render3D,
    probability_diagram: renderProbabilityTree,
    probability_tree: renderProbabilityTree,
  };

  const MathVisual = {
    /* Every template this build actually supports (used for validation and
       for the classification pass over the task bank, not just the UI). */
    supportedTypes: Object.keys(TEMPLATES),

    render(container, spec) {
      if (!container) return { ok: false, error: "no container" };
      try {
        if (typeof JXG === "undefined") throw new VisualError("библиотека визуализации не загружена");
        if (!spec || typeof spec !== "object") throw new VisualError("пустое описание визуала");
        const template = TEMPLATES[spec.type];
        if (!template) throw new VisualError(`неизвестный тип визуала "${spec.type}"`);
        container.innerHTML = "";
        container.className = "task-visual mathvisual-host";
        if (spec.type !== "probability_diagram" && spec.type !== "probability_tree") {
          container.classList.add("mathvisual-jsx");
        }
        template(container, spec, theme());
        return { ok: true };
      } catch (err) {
        renderFallback(container, err && err.message ? err.message : String(err));
        if (global.console) console.warn("MathVisual render failed:", err);
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    },
  };

  global.MathVisual = MathVisual;
})(typeof window !== "undefined" ? window : this);
