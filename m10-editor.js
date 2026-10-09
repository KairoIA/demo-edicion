/*!
 * m10-editor.js · Modo edición para webs estáticas alojadas en GitHub Pages
 * Mesa 10 Studio · v1.0 · un solo fichero, sin dependencias ni compilación
 *
 * Instalación (una línea antes de </body>):
 *   <script src="m10-editor.js" defer data-repo="DUEÑO/REPO" data-branch="main"
 *           data-base="/nombre-proyecto/" data-dir=""></script>
 *
 * Se activa con #editar al final de la dirección o con Ctrl+Mayús+E.
 * Sin activar no toca la página: solo escucha el atajo.
 *
 * Idea clave: lo que se publica NO es la página que se ve (puede llevar cosas
 * añadidas por JavaScript), sino el HTML ORIGINAL del repositorio con los
 * cambios aplicados encima.
 */
(function () {
  'use strict';
  if (window.M10Editor) return; // incluido dos veces

  // ─────────────────────────── 1. Configuración ───────────────────────────
  const etiqueta = document.currentScript || document.querySelector('script[data-repo][src*="m10-editor"]');
  const datos = (etiqueta && etiqueta.dataset) || {};
  const CFG = { repo: (datos.repo || '').trim(), rama: (datos.branch || 'main').trim(), base: datos.base || '/', dir: datos.dir || '' };
  const API = 'https://api.github.com';
  const CLAVE_TOKEN = 'm10-editor-token:' + CFG.repo;
  const AUTO_TEXTO = 'h1,h2,h3,h4,h5,h6,p,li,figcaption,blockquote,td,th,button,a,label,span,strong,em';
  const FUERA = 'script,style,noscript,template,svg,math,iframe,textarea,select,[data-m10-no-edit],[contenteditable]';
  const UNA_LINEA = /^(H[1-6]|A|BUTTON|LABEL|SPAN|STRONG|EM)$/;
  const NO_EDITABLE = 'Esta parte la crea la web automáticamente al cargar: no se puede editar aquí.';
  const MAX_ANCHO = 2000;

  let activo = false, S = null, host = null, ui = {}, hojaPagina = null, obs = null, escucha = null;
  let enEdicion = null, antesHijos = null, antesHtml = '', tokenMemoria = null;

  // ─────────────────────────── 2. Utilidades ───────────────────────────
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const espera = ms => new Promise(r => setTimeout(r, ms));
  const carpeta = ruta => ruta.replace(/[^/]*$/, '');
  const parsear = html => new DOMParser().parseFromString(html, 'text/html');
  const plural = n => (n === 1 ? '1 cambio' : n + ' cambios');
  const clonarHijos = el => [...el.childNodes].map(n => n.cloneNode(true));

  /** Crea un elemento de la interfaz. Los textos van siempre como texto, nunca como HTML. */
  function h(tag, props, ...hijos) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const c of hijos.flat()) if (c != null && c !== false) el.append(c);
    return el;
  }

  /** Base64 de GitHub → texto UTF-8 (sin perder tildes ni eñes). */
  function b64ATexto(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  }
  function bytesAB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  const textoAB64 = t => bytesAB64(new TextEncoder().encode(t));

  function marcar(el, marca, si = true) {
    const m = new Set((el.getAttribute('data-m10') || '').split(' ').filter(Boolean));
    si ? m.add(marca) : m.delete(marca);
    m.size ? el.setAttribute('data-m10', [...m].join(' ')) : el.removeAttribute('data-m10');
    S.marcados.add(el);
  }

  // ─────────────────── 3. De la dirección web al fichero del repo ───────────────────
  /** "/proyecto/blog/x.html" → "web/blog/x.html" (según data-base y data-dir). null si está fuera de data-base. */
  function rutaRepo(pathname, base = CFG.base, dir = CFG.dir) {
    let p;
    try { p = decodeURIComponent(pathname); } catch (e) { p = pathname; }
    const b = '/' + base.replace(/^\/+|\/+$/g, '');
    if (b === '/') p = p.replace(/^\/+/, '');
    else if (p === b) p = '';
    else if (p.startsWith(b + '/')) p = p.slice(b.length + 1);
    else return null;
    let d = dir.replace(/^\/+/, '');
    if (d && !d.endsWith('/')) d += '/';
    return d + p;
  }
  /** Ficheros posibles de la página: ".../" → index.html; "/contacto" → contacto.html o contacto/index.html. */
  function rutasPagina(pathname, base, dir) {
    const r = rutaRepo(pathname, base, dir);
    if (r === null) return [];
    if (r === '' || r.endsWith('/')) return [r + 'index.html'];
    if (/\.[a-z0-9]+$/i.test(r.split('/').pop())) return [r];
    return [r + '.html', r + '/index.html'];
  }

  // ─────────────────────────── 4. GitHub y token ───────────────────────────
  const urlContenido = ruta => `/repos/${CFG.repo}/contents/${ruta.split('/').map(encodeURIComponent).join('/')}`;
  const conRama = () => '?ref=' + encodeURIComponent(CFG.rama);

  async function api(metodo, ruta, cuerpo, token) {
    const cab = { Accept: 'application/vnd.github+json' };
    if (token) cab.Authorization = 'Bearer ' + token;
    if (cuerpo) cab['Content-Type'] = 'application/json';
    let r;
    try {
      r = await fetch(API + ruta, { method: metodo, headers: cab, body: cuerpo ? JSON.stringify(cuerpo) : undefined, cache: 'no-store' });
    } catch (e) {
      throw new Error('No se pudo conectar con GitHub. Revisa la conexión a Internet y vuelve a intentarlo.');
    }
    let json = null;
    try { json = await r.json(); } catch (e) { /* respuesta sin cuerpo */ }
    return { status: r.status, ok: r.ok, datos: json };
  }

  function errorApi(r, que) {
    if (r.status === 401) borrarToken();
    const m = {
      401: 'La llave (token) no es válida o ha caducado. Vuelve a publicar y pon una nueva.',
      403: 'GitHub no lo permite: la llave no tiene permiso «Contents: Read and write» o se ha superado el límite de consultas.',
      404: 'No encuentro el repositorio ' + CFG.repo + ' (o la llave no tiene acceso a él).',
    }[r.status];
    return new Error(m || `GitHub respondió con un error (${r.status}) al ${que}.`);
  }

  // El token nunca se escribe en consola ni en la página: solo en el almacén elegido.
  function almacen(tipo) { try { return window[tipo]; } catch (e) { return null; } }
  function dondeToken() {
    for (const [tipo, nombre] of [['localStorage', 'local'], ['sessionStorage', 'sesion']]) {
      try { if (almacen(tipo).getItem(CLAVE_TOKEN)) return nombre; } catch (e) { /* almacén bloqueado */ }
    }
    return tokenMemoria ? 'sesion' : null;
  }
  function leerToken() {
    for (const tipo of ['localStorage', 'sessionStorage']) {
      try { const t = almacen(tipo).getItem(CLAVE_TOKEN); if (t) return t; } catch (e) { /* bloqueado */ }
    }
    return tokenMemoria;
  }
  function guardarToken(t, recordar) {
    borrarToken();
    try { almacen(recordar ? 'localStorage' : 'sessionStorage').setItem(CLAVE_TOKEN, t); } catch (e) { tokenMemoria = t; }
  }
  function borrarToken() {
    for (const tipo of ['localStorage', 'sessionStorage']) { try { almacen(tipo).removeItem(CLAVE_TOKEN); } catch (e) { /* nada */ } }
    tokenMemoria = null;
  }

  /** Lee el HTML original de la página desde GitHub (no la página que se ve). */
  async function cargarOriginal() {
    const rutas = rutasPagina(location.pathname);
    if (!rutas.length) throw new Error(`La dirección de esta página no empieza por data-base="${CFG.base}". Revisa la etiqueta del editor.`);
    let token = leerToken(), ultimo = null;
    for (const ruta of rutas) {
      let r = await api('GET', urlContenido(ruta) + conRama(), null, token);
      if (r.status === 401 && token) { borrarToken(); token = null; r = await api('GET', urlContenido(ruta) + conRama()); }
      if (r.ok && r.datos && r.datos.type === 'file') {
        let b64 = r.datos.content;
        if (r.datos.encoding !== 'base64' || !b64) { // ficheros de más de 1 MB: se piden como «blob»
          const b = await api('GET', `/repos/${CFG.repo}/git/blobs/${r.datos.sha}`, null, token);
          if (!b.ok) throw errorApi(b, 'leer la página');
          b64 = b.datos.content;
        }
        const texto = b64ATexto(b64), bom = texto.charCodeAt(0) === 0xfeff; // el BOM se aparta y se repone al publicar
        const fuente = bom ? texto.slice(1) : texto;
        Object.assign(S, { bom, fuente, sha: r.datos.sha, ruta, doc: parsear(fuente) });
        return;
      }
      ultimo = r;
      if (r.status !== 404 && !(r.ok && r.datos && r.datos.type !== 'file')) break;
    }
    const e = new Error(
      ultimo && ultimo.status === 403
        ? 'GitHub limita las consultas sin llave (60 por hora). Pon tu token o espera un rato.'
        : `No encuentro esta página en GitHub (${CFG.repo}, rama ${CFG.rama}, fichero ${rutas.join(' o ')}). ` +
          'Si el repositorio es privado, pon el token; si no, revisa data-repo, data-dir y data-base.'
    );
    e.pedirToken = !token;
    throw e;
  }

  // ─────────────────────────── 5. Interfaz (barra y paneles) ───────────────────────────
  const CSS_UI = `
:host{all:initial} *{box-sizing:border-box} [hidden]{display:none!important}
.barra,.panel,.aviso,.pildora{position:fixed;z-index:2147483000;font:500 14px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#EAEAEB;background:#141414;border:1px solid #2C2C30;box-shadow:0 10px 30px rgba(0,0,0,.35);-webkit-font-smoothing:antialiased}
.barra{left:50%;bottom:calc(12px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px;max-width:calc(100vw - 16px);padding:6px;border-radius:14px}
.grupo{display:flex;align-items:center;gap:2px} .modos{background:#0C0C0D;border-radius:10px;padding:2px}
button{font:inherit;color:inherit;background:transparent;border:0;border-radius:9px;padding:0 12px;min-height:38px;cursor:pointer;white-space:nowrap}
button:hover{background:#232326} button:disabled{opacity:.45;cursor:default;background:transparent}
button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid #799BC1;outline-offset:2px}
button[aria-pressed="true"]{background:#232A33;color:#B9CCE2;box-shadow:inset 0 0 0 1px #4D6582}
.principal,.principal:disabled{background:#799BC1;color:#101012;font-weight:600} .principal:hover{background:#8DAACB}
.contador{color:#A3A3A8;font-weight:400;font-variant-numeric:tabular-nums} .contador.hay{color:#E3B26B} .plegar{padding:0 10px;color:#A3A3A8}
.pildora{right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));border-radius:999px;padding:0 16px;min-height:40px}
.panel{left:50%;transform:translateX(-50%);bottom:var(--hueco,72px);width:min(440px,calc(100vw - 16px));max-height:calc(100vh - var(--hueco,72px) - 16px);overflow:auto;padding:16px;border-radius:14px;font-weight:400}
.panel h2{margin:0 0 10px;font-size:16px;font-weight:600} .panel p,.panel ol,.panel ul{margin:0 0 10px} .panel ol,.panel ul{padding-left:20px} .panel li{margin:3px 0} .panel a{color:#9DB8D6}
.panel label{display:block;margin:10px 0 4px;color:#C9C9CE;font-size:13px} .panel label.casilla{display:flex;gap:8px;align-items:center;color:#EAEAEB;font-size:14px}
.panel input[type=text],.panel input[type=password]{width:100%;min-height:40px;padding:8px 10px;color:#EAEAEB;background:#0C0C0D;border:1px solid #34343A;border-radius:9px;font:inherit}
.panel .botones{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:14px} .panel .botones button{border:1px solid #34343A} .panel .botones .principal{border-color:#799BC1}
.panel img.previa{display:block;max-width:100%;max-height:160px;margin:0 auto 10px;border-radius:8px;background:#0C0C0D}
.nota{color:#A3A3A8;font-size:13px} .error{color:#F0A3A3;min-height:1em}
.aviso{left:50%;transform:translateX(-50%);bottom:var(--hueco,72px);width:max-content;max-width:min(440px,calc(100vw - 16px));padding:10px 14px;border-radius:10px;font-weight:400}
.aviso.ok{border-color:#4D6582} .aviso.error{border-color:#8A4B4B;color:#F3C6C6} .panel:not([hidden])~.aviso{display:none}
@media (max-width:600px){
 .barra{left:8px;right:8px;transform:none;max-width:none;bottom:calc(8px + env(safe-area-inset-bottom,0px))}
 .grupo{width:100%;justify-content:space-between} .modos button{flex:1}
 .panel,.aviso{left:8px;right:8px;transform:none;width:auto;max-width:none}
}`;

  // Estilos que se ponen en la página SOLO mientras se edita (nunca se publican).
  const CSS_PAGINA = `
html[data-m10-modo] [data-m10~="t"]{-webkit-user-select:text!important;user-select:text!important}
html[data-m10-modo] a{-webkit-user-drag:none}
html[data-m10-modo="textos"] [data-m10~="t"]{cursor:text}
html[data-m10-modo="textos"] [data-m10~="t"]:hover{outline:2px dashed #799BC1!important;outline-offset:3px!important}
html[data-m10-modo="textos"] [data-m10~="t"]:focus{outline:2px solid #799BC1!important;outline-offset:3px!important}
html[data-m10-modo="imagenes"] [data-m10~="i"],html[data-m10-modo="enlaces"] [data-m10~="a"]{cursor:pointer}
html[data-m10-modo="imagenes"] [data-m10~="i"]:hover,html[data-m10-modo="enlaces"] [data-m10~="a"]:hover{outline:3px solid #799BC1!important;outline-offset:2px!important}
html[data-m10-modo="textos"] [data-m10~="xt"]:hover,html[data-m10-modo="imagenes"] [data-m10~="xi"]:hover,html[data-m10-modo="enlaces"] [data-m10~="xa"]:hover{outline:1px dashed #8C8C92!important;outline-offset:2px!important;cursor:not-allowed}
@media (hover:none){
 html[data-m10-modo="textos"] [data-m10~="t"]:not(:focus),html[data-m10-modo="imagenes"] [data-m10~="i"],html[data-m10-modo="enlaces"] [data-m10~="a"]{outline:1px dashed rgba(121,155,193,.75)!important;outline-offset:2px!important}
}
/* lo modificado, en ámbar (el :not(#…) solo sube la prioridad) */
html[data-m10-modo] [data-m10~="c"]:not(#m10-z){outline:2px solid #E3B26B!important;outline-offset:3px!important}`;

  function montar() {
    host = h('div', { id: 'm10-editor-host', 'data-estado': 'cargando' });
    const sombra = host.attachShadow({ mode: 'open' });
    const modo = (id, texto) => h('button', { type: 'button', 'data-modo': id, 'aria-pressed': 'false', on: { click: () => cambiarModo(id) } }, texto);
    ui.botonesModo = [modo('textos', 'Textos'), modo('imagenes', 'Imágenes'), modo('enlaces', 'Enlaces')];
    ui.deshacer = h('button', { type: 'button', title: 'Deshacer el último cambio', on: { click: deshacer } }, 'Deshacer');
    ui.contador = h('button', { type: 'button', class: 'contador', title: 'Ver los cambios', on: { click: panelResumen } }, 'Sin cambios');
    ui.publicar = h('button', { type: 'button', class: 'principal', on: { click: publicar } }, 'Publicar');
    ui.salir = h('button', { type: 'button', on: { click: () => salir(false) } }, 'Salir');
    ui.barra = h('div', { class: 'barra', role: 'toolbar', 'aria-label': 'Modo edición' },
      h('div', { class: 'grupo modos' }, ui.botonesModo),
      h('div', { class: 'grupo acciones' }, ui.deshacer, ui.contador, ui.publicar, ui.salir,
        h('button', { type: 'button', class: 'plegar', title: 'Plegar la barra', 'aria-label': 'Plegar la barra', on: { click: plegar } }, '▾')));
    ui.pildora = h('button', { type: 'button', class: 'pildora', hidden: true, on: { click: plegar } }, 'Editar ▴');
    ui.aviso = h('div', { class: 'aviso', role: 'status', 'aria-live': 'polite', hidden: true });
    ui.panel = h('div', { class: 'panel', role: 'dialog', hidden: true });
    ui.panel.addEventListener('keydown', e => {
      if (e.key === 'Escape') cerrarPanel();
      else if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
        const p = ui.panel.querySelector('.botones .principal');
        if (p) { e.preventDefault(); p.click(); }
      }
    });
    // Lo que se teclea en la barra o en los paneles no llega a los atajos de la web
    for (const t of ['keydown', 'keyup', 'keypress']) host.addEventListener(t, e => e.stopPropagation());
    sombra.append(h('style', null, CSS_UI), ui.panel, ui.aviso, ui.barra, ui.pildora);
    document.body.append(host);
    document.head.append(hojaPagina = h('style', { id: 'm10-editor-estilos' }, CSS_PAGINA));
    S.estiloBody = document.body.getAttribute('style');
    S.paddingBase = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
    if (window.ResizeObserver) new ResizeObserver(ajustarHueco).observe(ui.barra);
    habilitar(false);
    ajustarHueco();
  }

  /** Deja hueco abajo para que la barra no tape el final de la página. */
  function ajustarHueco() {
    if (!host) return;
    const alto = (S.plegada ? ui.pildora : ui.barra).getBoundingClientRect().height;
    const hueco = Math.ceil(alto + 20);
    host.style.setProperty('--hueco', hueco + 'px');
    document.body.style.paddingBottom = S.paddingBase + hueco + 'px';
  }
  function plegar() {
    S.plegada = !S.plegada;
    ui.barra.hidden = S.plegada;
    ui.pildora.hidden = !S.plegada;
    if (S.plegada) cerrarPanel();
    ajustarHueco();
  }
  function habilitar(si) {
    for (const b of ui.barra.querySelectorAll('button')) if (b !== ui.salir && !b.classList.contains('plegar')) b.disabled = !si;
  }
  const ponerEstado = e => host && host.setAttribute('data-estado', e);

  function aviso(msg, tipo = 'info', ms = 3500) {
    if (!ui.aviso) return;
    clearTimeout(S.tAviso);
    ui.aviso.textContent = msg;
    ui.aviso.className = 'aviso ' + tipo;
    ui.aviso.hidden = false;
    if (ms) S.tAviso = setTimeout(() => { ui.aviso.hidden = true; }, ms);
  }

  function abrirPanel(titulo, hijos, alCerrar) {
    cerrarPanel();
    ui.panel.replaceChildren(h('h2', null, titulo), ...hijos.filter(Boolean));
    ui.panel.hidden = false;
    S.alCerrar = alCerrar || null;
    const foco = ui.panel.querySelector('input[type=text], input[type=password], .botones .principal');
    if (foco && matchMedia('(hover: hover)').matches) setTimeout(() => foco.focus(), 0);
  }
  function cerrarPanel() {
    if (!ui.panel || ui.panel.hidden) return;
    const cb = S.alCerrar;
    S.alCerrar = null;
    ui.panel.hidden = true;
    ui.panel.replaceChildren();
    if (cb) cb();
  }
  const botones = (...defs) => h('div', { class: 'botones' },
    defs.filter(Boolean).map(([texto, fn, principal]) => h('button', { type: 'button', class: principal ? 'principal' : null, on: { click: fn } }, texto)));
  const enlaceExterno = (href, texto) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, texto);

  /** Pide el token, lo valida contra GitHub y lo guarda. Devuelve el token o null. */
  function pedirToken() {
    return new Promise(resolver => {
      const campo = h('input', { type: 'password', id: 'm10-token', autocomplete: 'off', spellcheck: 'false', placeholder: 'github_pat_…' });
      const recordar = h('input', { type: 'checkbox', id: 'm10-recordar' });
      const error = h('p', { class: 'error', role: 'alert' });
      let hecho = false;
      const terminar = valor => { if (hecho) return; hecho = true; campo.value = ''; S.alCerrar = null; cerrarPanel(); resolver(valor); };
      const guardar = async () => {
        const t = campo.value.trim();
        if (!t) { error.textContent = 'Pega el token primero.'; return; }
        error.textContent = 'Comprobando la llave…';
        try {
          const r = await api('GET', '/repos/' + CFG.repo, null, t);
          if (r.ok && !(r.datos && r.datos.permissions && r.datos.permissions.push === false)) { guardarToken(t, recordar.checked); terminar(t); return; }
          error.textContent = r.status === 401 ? 'Esa llave no es válida o ha caducado.'
            : r.ok ? 'Esa llave solo puede leer. Necesita «Contents: Read and write».'
            : 'Esa llave no tiene acceso a ' + CFG.repo + '.';
        } catch (e) { error.textContent = e.message; }
      };
      abrirPanel('Llave para publicar', [
        h('p', null, 'Para publicar, GitHub pide una llave (un «token»). Se crea una sola vez:'),
        h('ol', null,
          h('li', null, 'Abre ', enlaceExterno('https://github.com/settings/personal-access-tokens/new', 'github.com/settings/personal-access-tokens/new'), '.'),
          h('li', null, 'En «Repository access» elige «Only select repositories» y marca solo ', h('strong', null, CFG.repo), '.'),
          h('li', null, 'En «Permissions» busca «Contents» y elige «Read and write».'),
          h('li', null, 'Pulsa «Generate token», cópialo y pégalo aquí.')),
        h('label', { for: 'm10-token' }, 'Token'), campo,
        h('label', { class: 'casilla' }, recordar, 'Recordar en este dispositivo'),
        h('p', { class: 'nota' }, 'No lo marques en un ordenador compartido. Sin marcar, se olvida al cerrar la pestaña.'),
        error,
        botones(dondeToken() && ['Olvidar token', () => { borrarToken(); error.textContent = 'Token olvidado.'; }],
          ['Cancelar', () => terminar(null)], ['Guardar y continuar', guardar, true]),
      ], () => terminar(null));
    });
  }

  function panelResumen() {
    cerrarEdicion();
    const lista = listaCambios(), donde = dondeToken();
    const corto = s => { s = norm(s); return s.length > 60 ? s.slice(0, 57) + '…' : s; };
    const describir = ([tipo, el]) => {
      if (tipo === 'texto') return 'Texto: «' + corto(firmaTexto(el).replace(/\u0001/g, ' ')) + '»';
      if (tipo === 'enlace') return 'Enlace → ' + corto(el.getAttribute('href'));
      const n = S.nuevas.get(el);
      return (el.tagName === 'IMG' ? 'Imagen: ' : 'Fondo: ') + (n ? n.rutaRepo.split('/').pop() : 'texto alternativo');
    };
    abrirPanel('Cambios sin publicar', [
      lista.length ? h('ul', null, lista.map(c => h('li', null, describir(c)))) : h('p', null, 'Todavía no has cambiado nada.'),
      h('p', { class: 'nota' }, donde === 'local' ? 'Llave de GitHub: guardada en este dispositivo.'
        : donde === 'sesion' ? 'Llave de GitHub: guardada hasta cerrar esta pestaña.'
        : 'Llave de GitHub: aún no puesta (se pide al publicar).'),
      botones(donde && ['Olvidar token', () => { borrarToken(); cerrarPanel(); aviso('Token olvidado en este dispositivo.', 'ok'); }],
        ['Cerrar', cerrarPanel, true]),
    ]);
  }

  // ─────────────────── 6. Qué se puede editar (y emparejarlo con el original) ───────────────────
  /** Ruta estable desde <body>: [[etiqueta, nº entre hermanos con esa etiqueta], …]. */
  function rutaDesdeBody(el) {
    const r = [];
    for (let n = el; n && n.parentElement && n.tagName !== 'BODY'; n = n.parentElement) {
      let i = 0;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
      r.unshift([n.tagName, i]);
    }
    return r;
  }
  function resolverRuta(doc, ruta) {
    let n = doc.body;
    for (const [tag, i] of ruta) {
      let k = -1, hallado = null;
      for (const c of n.children) if (c.tagName === tag && ++k === i) { hallado = c; break; }
      if (!hallado) return null;
      n = hallado;
    }
    return n;
  }
  const cadena = el => { const r = []; for (let n = el; n && n.tagName !== 'BODY'; n = n.parentElement) r.push(n.tagName); return r.join('<'); };

  // «Firma» que debe coincidir entre la página viva y el original para poder editar
  const FIRMA = {
    t: el => norm(el.textContent),
    i: el => (el.tagName === 'IMG' ? 'src:' + el.getAttribute('src') : 'fondo:' + el.getAttribute('data-m10-bg')),
    a: el => el.getAttribute('href') + '|' + norm(el.textContent),
  };

  /** Textos editables: los marcados con data-m10-edit o, si no hay, detección automática. */
  function candidatosTexto() {
    const marcadosAutor = document.body.querySelectorAll('[data-m10-edit]');
    const lista = marcadosAutor.length ? marcadosAutor : document.body.querySelectorAll(AUTO_TEXTO);
    const elegidos = new Set();
    for (const el of lista) {
      if (el.closest(FUERA)) continue;
      if (!marcadosAutor.length && ![...el.childNodes].some(n => n.nodeType === 3 && n.data.trim())) continue; // sin texto propio
      let dentro = false;
      for (let p = el.parentElement; p && !dentro; p = p.parentElement) dentro = elegidos.has(p);
      if (!dentro) elegidos.add(el); // el de fuera manda: un <strong> dentro de un <p> va con el <p>
    }
    return [...elegidos];
  }

  function aceptar(v, o, rol) { S.pares.set(v, o); S.usados.add(o); S.rol[rol].add(v); marcar(v, rol); }

  /** Empareja cada elemento vivo con el del HTML original. Lo que no está en el original queda «no editable». */
  function emparejar(vivos, rol) {
    const firma = FIRMA[rol], pendientes = [];
    for (const v of vivos) {
      let o = S.pares.get(v);
      if (!o) {
        const c = resolverRuta(S.doc, rutaDesdeBody(v));
        if (c && c.tagName === v.tagName && !S.usados.has(c)) o = c;
      }
      if (o && firma(o) === firma(v)) aceptar(v, o, rol);
      else if (S.pares.has(v)) marcar(v, 'x' + rol);
      else pendientes.push(v);
    }
    if (!pendientes.length) return;
    // 2ª pasada (por si JavaScript insertó algo antes y movió las posiciones):
    // misma cadena de etiquetas y misma firma, y única a ambos lados.
    const clave = el => cadena(el) + '\u0000' + firma(el);
    const tags = new Set(pendientes.map(v => v.tagName)), orig = new Map(), vivas = new Map();
    for (const o of S.doc.body.getElementsByTagName('*')) {
      if (tags.has(o.tagName) && !S.usados.has(o)) { const k = clave(o); orig.set(k, (orig.get(k) || []).concat(o)); }
    }
    for (const v of pendientes) { const k = clave(v); vivas.set(k, (vivas.get(k) || 0) + 1); }
    for (const v of pendientes) {
      const k = clave(v), c = orig.get(k) || [];
      if (c.length === 1 && vivas.get(k) === 1 && !S.usados.has(c[0])) aceptar(v, c[0], rol);
      else marcar(v, 'x' + rol);
    }
  }

  function prepararElementos() {
    const dentro = el => !el.closest(FUERA);
    emparejar(candidatosTexto(), 't');
    emparejar([...document.body.querySelectorAll('img[src], [data-m10-bg]')].filter(dentro), 'i');
    emparejar([...document.body.querySelectorAll('a[href]')].filter(dentro), 'a');
  }

  /** Si la web cambia sola algo ya emparejado (relojes, contadores…), deja de ser editable. */
  function alMutar(registros) {
    for (const r of registros) {
      let el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      if (!el || (enEdicion && enEdicion.contains(el))) continue; // lo está escribiendo la persona
      if (r.type === 'attributes') { bloquear(el, r.attributeName === 'href' ? 'a' : 'i'); continue; }
      for (; el && el !== document.body; el = el.parentElement) if (S.rol.t.has(el)) { bloquear(el, 't'); break; }
    }
  }
  function bloquear(el, rol) {
    if (!S.rol[rol].has(el)) return;
    S.rol[rol].delete(el);
    marcar(el, rol, false);
    marcar(el, 'x' + rol);
    if (rol === 't') el.removeAttribute('contenteditable');
    if (!S.avisoBloqueo) { S.avisoBloqueo = true; aviso('Una parte de la página ha cambiado sola (la cambia la web) y ya no se puede editar.', 'info', 5000); }
    actualizar();
  }

  // ─────────────────────────── 7. Editar: modos, textos, deshacer ───────────────────────────
  function cambiarModo(m) {
    cerrarEdicion();
    cerrarPanel();
    S.modo = m;
    document.documentElement.setAttribute('data-m10-modo', m);
    for (const el of S.rol.t) m === 'textos' ? el.setAttribute('contenteditable', 'true') : el.removeAttribute('contenteditable');
    for (const b of ui.botonesModo) b.setAttribute('aria-pressed', String(b.dataset.modo === m));
    aviso({ textos: 'Haz clic en un texto para cambiarlo. Intro = terminar.', imagenes: 'Toca una imagen para cambiarla.', enlaces: 'Toca un enlace para cambiar su texto o su dirección.' }[m]);
  }

  const hostTexto = n => { for (; n && n !== document.body; n = n.parentElement) if (S.rol.t.has(n)) return n; return null; };

  function alEnfocar(e) {
    if (!S.rol.t.has(e.target) || e.target === enEdicion) return;
    cerrarEdicion();
    enEdicion = e.target;
    antesHijos = clonarHijos(enEdicion);
    antesHtml = enEdicion.innerHTML;
  }
  /** Al salir de un texto, si cambió, se guarda en la pila de deshacer. */
  function cerrarEdicion() {
    if (obs) obs.takeRecords();
    const el = enEdicion;
    if (!el) return;
    enEdicion = null;
    if (el.innerHTML !== antesHtml) {
      const copia = antesHijos;
      if (pierdeElementos(S.pares.get(el), el)) { // p. ej. se borró el logo que va dentro del texto
        el.replaceChildren(...copia);
        aviso('Ese texto lleva dentro una imagen o un icono que no se puede borrar desde aquí (ni partir con saltos de línea). He deshecho ese cambio.', 'error', 8000);
      } else {
        apilar(() => el.replaceChildren(...copia.map(n => n.cloneNode(true))));
        S.tocados.add(el);
      }
    }
    actualizar();
  }

  function alTeclear(e) {
    if (!enEdicion || !enEdicion.contains(e.target)) return;
    if (e.key === 'Enter') {
      e.preventDefault(); // nada de saltos raros: Intro termina, Mayús+Intro = salto de línea (no en títulos)
      if (e.shiftKey && !UNA_LINEA.test(enEdicion.tagName)) document.execCommand('insertLineBreak');
      else enEdicion.blur();
    } else if (e.key === 'Escape') enEdicion.blur();
    else if ((e.ctrlKey || e.metaKey) && /^[biu]$/i.test(e.key)) e.preventDefault(); // sin negritas sueltas
    else if (e.key === ' ' && enEdicion.closest('button, summary, [role=button]')) {
      e.preventDefault(); // en un botón, el espacio «pulsaría» el botón en vez de escribirse
      document.execCommand('insertText', false, ' ');
    }
  }

  /** Pegar siempre como texto plano. */
  function alPegar(e) {
    if (!enEdicion || !enEdicion.contains(e.target)) return;
    e.preventDefault();
    let t = ((e.clipboardData && e.clipboardData.getData('text/plain')) || '').replace(/\r\n?/g, '\n');
    if (UNA_LINEA.test(enEdicion.tagName)) t = t.replace(/\s*\n\s*/g, ' ');
    t.split('\n').forEach((parte, i) => {
      if (i) document.execCommand('insertLineBreak');
      if (parte) document.execCommand('insertText', false, parte);
    });
  }

  function alClic(e) {
    if (!activo || e.composedPath().includes(host)) return; // clics en la barra
    const t = e.target.nodeType === 1 ? e.target : e.target.parentElement;
    if (!t) return;
    const a = t.closest('a');
    if (a) e.preventDefault(); // en modo edición no se navega (se perderían los cambios)
    if (S.modo === 'imagenes') {
      // También lo que está debajo del dedo (fotos tapadas por un degradado u otra capa)
      const debajo = e.detail ? document.elementsFromPoint(e.clientX, e.clientY) : [];
      const el = [t.closest('img, [data-m10-bg]'), ...debajo].find(n => n && S.rol.i.has(n));
      if (el) { e.preventDefault(); e.stopPropagation(); panelImagen(el); }
      else if (t.closest('[data-m10~="xi"]')) aviso(NO_EDITABLE);
    } else if (S.modo === 'enlaces') {
      if (a && S.rol.a.has(a)) { e.stopPropagation(); panelEnlace(a); }
      else if (a) aviso(NO_EDITABLE);
    } else if (hostTexto(t)) {
      // Clic en un botón o etiqueta editable: se edita, no se «pulsa»
      if (t.closest('button, label, summary, [role=button]')) { e.preventDefault(); e.stopPropagation(); }
    } else if (t.closest('[data-m10~="xt"]')) aviso(NO_EDITABLE);
  }

  function apilar(fn) { S.pila.push(fn); if (S.pila.length > 200) S.pila.shift(); }
  function deshacer() {
    cerrarEdicion();
    const fn = S.pila.pop();
    if (!fn) return aviso('No hay nada que deshacer.');
    fn();
    if (obs) obs.takeRecords();
    actualizar();
  }

  /** Texto «comparable»: espacios normalizados y <br> como salto. */
  function firmaTexto(el) {
    let s = '';
    (function rec(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) s += c.data;
        else if (c.nodeName === 'BR') s += '\u0001';
        else if (c.nodeType === 1) rec(c);
      }
    })(el);
    return s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').replace(/[\s\u0001]+$/, '').trim();
  }

  /** Lista de cambios reales respecto al original: [tipo, elemento vivo]. */
  function listaCambios() {
    const r = [];
    if (!S || !S.doc) return r;
    for (const el of S.tocados) {
      const o = S.pares.get(el);
      if (!o) continue;
      if (S.rol.t.has(el) && firmaTexto(el) !== firmaTexto(o)) r.push(['texto', el]);
      if (S.rol.a.has(el) && el.getAttribute('href') !== o.getAttribute('href')) r.push(['enlace', el]);
      if (S.rol.i.has(el) && (S.nuevas.has(el) || (el.tagName === 'IMG' && (el.getAttribute('alt') || '') !== (o.getAttribute('alt') || '')))) r.push(['imagen', el]);
    }
    return r;
  }

  function actualizar() {
    if (!ui.contador) return;
    const lista = listaCambios(), cambiados = new Set(lista.map(c => c[1]));
    for (const el of S.tocados) marcar(el, 'c', cambiados.has(el));
    ui.contador.textContent = lista.length ? plural(lista.length) : 'Sin cambios';
    ui.contador.classList.toggle('hay', lista.length > 0);
    if (S.listo) ui.publicar.disabled = !lista.length || S.ocupado;
    if (obs) obs.takeRecords();
  }

  // ─────────────────────────── 8. Imágenes ───────────────────────────
  const slug = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'imagen';
  function fecha() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
  const RE_URL = /url\(\s*(['"]?)([^)'"]*)\1\s*\)/i;
  const srcDeFondo = estilo => { const m = RE_URL.exec(estilo || ''); return m ? m[2] : null; };
  /** Cambia (o añade) la imagen de fondo dentro del atributo style, sin tocar lo demás. */
  function conFondo(estilo, src) {
    const url = `url('${src}')`;
    if (estilo && RE_URL.test(estilo)) return estilo.replace(RE_URL, url);
    return (estilo ? estilo.replace(/;?\s*$/, '; ') : '') + 'background-image: ' + url;
  }

  /** Dónde guardar la imagen nueva: misma carpeta que la original, nombre = slug + fecha. */
  function destinoImagen(srcOriginal, nombreArchivo, ext) {
    const baseNombre = srcOriginal ? srcOriginal.split(/[?#]/)[0].split('/').pop().replace(/\.[^.]*$/, '') : nombreArchivo.replace(/\.[^.]*$/, '');
    const nombre = slug(baseNombre.replace(/-\d{8}-\d{6}(-\d+)?$/, '')) + '-' + fecha() + '.' + ext;
    let carpetaRepo = carpeta(S.ruta) + 'img/', carpetaSrc = 'img/';
    if (srcOriginal && !/^(data|blob):/i.test(srcOriginal)) {
      const u = new URL(srcOriginal, document.baseURI);
      const enRepo = u.origin === location.origin ? rutaRepo(u.pathname) : null;
      if (enRepo !== null) { carpetaRepo = carpeta(enRepo); carpetaSrc = carpeta(srcOriginal.split(/[?#]/)[0]); }
    }
    return { rutaRepo: carpetaRepo + nombre, src: carpetaSrc + nombre };
  }

  function cargarImagen(url) {
    return new Promise((ok, mal) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = () => mal(new Error('No se puede leer esa imagen. Prueba con una foto JPG o PNG.'));
      im.src = url;
    });
  }
  function hayTransparencia(ctx, w, hgt) {
    const d = ctx.getImageData(0, 0, w, hgt).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
    return false;
  }
  /** Reduce a 2000 px de ancho si hace falta (JPEG/WebP al 85 %; PNG con transparencia se queda PNG). */
  async function prepararImagen(archivo) {
    const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg' };
    const tipo = archivo.type;
    if (!EXT[tipo]) throw new Error('Formato no compatible. Usa una foto JPG, PNG o WebP.');
    const url = URL.createObjectURL(archivo);
    let im;
    try { im = await cargarImagen(url); } finally { URL.revokeObjectURL(url); }
    let w = im.naturalWidth, alto = im.naturalHeight;
    // GIF (animados) y SVG se suben tal cual; las fotos pequeñas y ligeras, también
    if (/gif|svg/.test(tipo) || (w <= MAX_ANCHO && archivo.size <= 2.5e6)) return { blob: archivo, ext: EXT[tipo], ancho: w, alto };
    if (w > MAX_ANCHO) { alto = Math.round(alto * MAX_ANCHO / w); w = MAX_ANCHO; }
    const lienzo = document.createElement('canvas');
    lienzo.width = w;
    lienzo.height = alto;
    const ctx = lienzo.getContext('2d');
    ctx.drawImage(im, 0, 0, w, alto);
    const transparente = tipo !== 'image/jpeg' && hayTransparencia(ctx, w, alto);
    let salida = tipo === 'image/webp' ? 'image/webp' : transparente ? 'image/png' : 'image/jpeg';
    let blob = await new Promise(ok => lienzo.toBlob(ok, salida, 0.85));
    if (!blob || blob.type !== salida) { salida = 'image/jpeg'; blob = await new Promise(ok => lienzo.toBlob(ok, salida, 0.85)); }
    if (!blob) throw new Error('No se ha podido preparar la imagen.');
    if (blob.size > 15e6) throw new Error('La imagen es demasiado pesada incluso reducida.');
    return { blob, ext: EXT[salida], ancho: w, alto };
  }

  const pictureDe = el => (el.parentElement && el.parentElement.tagName === 'PICTURE' ? el.parentElement : null);
  function vistaPrevia(el, url) {
    if (el.tagName !== 'IMG') return el.setAttribute('style', conFondo(el.getAttribute('style'), url));
    el.removeAttribute('srcset');
    el.removeAttribute('sizes');
    const pic = pictureDe(el);
    if (pic) pic.querySelectorAll('source').forEach(s => s.remove()); // si no, el navegador seguiría mostrando la vieja
    el.setAttribute('src', url);
  }
  function aplicarImagen(el, nueva, alt) {
    const pic = pictureDe(el);
    const antes = {
      attrs: ['src', 'srcset', 'sizes', 'alt', 'style'].map(a => [a, el.getAttribute(a)]),
      fuentes: pic ? [...pic.querySelectorAll('source')] : [],
      reg: S.nuevas.get(el),
    };
    apilar(() => {
      for (const [a, v] of antes.attrs) v === null ? el.removeAttribute(a) : el.setAttribute(a, v);
      if (pic) pic.prepend(...antes.fuentes);
      antes.reg ? S.nuevas.set(el, antes.reg) : S.nuevas.delete(el);
    });
    if (nueva) { S.nuevas.set(el, nueva); vistaPrevia(el, nueva.url); }
    if (alt !== null) el.setAttribute('alt', alt);
    S.tocados.add(el);
    actualizar();
  }

  function panelImagen(el) {
    const esImg = el.tagName === 'IMG', orig = S.pares.get(el);
    const srcOriginal = esImg ? orig.getAttribute('src') : srcDeFondo(orig.getAttribute('style'));
    let nueva = null, aplicada = false;
    const previa = h('img', { class: 'previa', alt: '' });
    const actual = S.nuevas.get(el);
    previa.src = actual ? actual.url : esImg ? el.currentSrc || el.src : (srcDeFondo(getComputedStyle(el).backgroundImage) || '');
    if (!previa.getAttribute('src')) previa.hidden = true;
    const archivo = h('input', { type: 'file', id: 'm10-archivo', accept: 'image/*', hidden: true });
    const info = h('p', { class: 'nota', id: 'm10-info-imagen' }, 'JPG, PNG o WebP. Las fotos grandes se reducen solas a 2000 px de ancho.');
    const alt = esImg ? h('input', { type: 'text', id: 'm10-alt', value: el.getAttribute('alt') || '' }) : null;
    const error = h('p', { class: 'error', role: 'alert' });
    archivo.addEventListener('change', async () => {
      const f = archivo.files && archivo.files[0];
      if (!f) return;
      error.textContent = '';
      info.textContent = 'Preparando la imagen…';
      try {
        const p = await prepararImagen(f);
        if (nueva) URL.revokeObjectURL(nueva.url);
        nueva = Object.assign(p, destinoImagen(srcOriginal, f.name, p.ext), { url: URL.createObjectURL(p.blob) });
        nueva.rutaBase = nueva.rutaRepo;
        nueva.srcBase = nueva.src;
        previa.src = nueva.url;
        previa.hidden = false;
        info.textContent = `Nueva: ${p.ancho} × ${p.alto} px, ${Math.max(1, Math.round(p.blob.size / 1024))} KB. Se guardará como ${nueva.rutaRepo}`;
      } catch (e) { error.textContent = e.message; info.textContent = ''; }
    });
    abrirPanel(esImg ? 'Imagen' : 'Imagen de fondo', [
      previa, info,
      h('button', { type: 'button', on: { click: () => archivo.click() } }, 'Elegir otra foto…'), archivo,
      alt && h('label', { for: 'm10-alt' }, 'Texto alternativo (describe la foto; lo leen Google y las personas ciegas)'), alt,
      error,
      botones(['Cancelar', cerrarPanel], ['Aplicar', () => {
        const nuevoAlt = alt && alt.value.trim() !== (el.getAttribute('alt') || '') ? alt.value.trim() : null;
        if (nueva || nuevoAlt !== null) { aplicada = true; aplicarImagen(el, nueva, nuevoAlt); }
        cerrarPanel();
      }, true]),
    ], () => { if (nueva && !aplicada) URL.revokeObjectURL(nueva.url); });
  }

  // ─────────────────────────── 9. Enlaces ───────────────────────────
  /** Arregla lo típico: «hola@x.com» → mailto:, «600 000 000» → tel:, «www.x.com» → https:// */
  function arreglarHref(v) {
    v = v.trim();
    if (/^[^\s@/:]+@[^\s@/]+\.[a-z]{2,}$/i.test(v)) return 'mailto:' + v;
    if (/^\+?[\d\s().-]{6,}$/.test(v)) return 'tel:' + v.replace(/[^\d+]/g, '');
    if (/^www\./i.test(v)) return 'https://' + v;
    return v;
  }
  function hrefInvalido(v) {
    if (!v) return 'Escribe una dirección.';
    if (/^\s*(javascript|data|vbscript):/i.test(v)) return 'Esa dirección no está permitida.';
    if (/\s/.test(v) && !/^mailto:/i.test(v)) return 'La dirección no puede llevar espacios.';
    return '';
  }
  function aplicarEnlace(a, texto, href) {
    const cambiaTexto = texto !== null && texto !== norm(a.textContent);
    if (href === a.getAttribute('href') && !cambiaTexto) return;
    const hrefAntes = a.getAttribute('href'), hijosAntes = clonarHijos(a);
    apilar(() => { a.setAttribute('href', hrefAntes); a.replaceChildren(...hijosAntes.map(n => n.cloneNode(true))); });
    a.setAttribute('href', href);
    if (cambiaTexto) { a.textContent = texto; S.tocados.add(hostTexto(a)); }
    S.tocados.add(a);
    actualizar();
  }
  function panelEnlace(a) {
    const soloTexto = a.children.length === 0 && hostTexto(a);
    const texto = soloTexto ? h('input', { type: 'text', id: 'm10-texto-enlace', value: norm(a.textContent) }) : null;
    const dir = h('input', { type: 'text', id: 'm10-href', value: a.getAttribute('href') || '', inputmode: 'url', autocapitalize: 'off', spellcheck: 'false' });
    const error = h('p', { class: 'error', role: 'alert' });
    abrirPanel('Enlace', [
      texto && h('label', { for: 'm10-texto-enlace' }, 'Texto que se ve'), texto,
      !texto && h('p', { class: 'nota' }, 'El texto de este enlace no se cambia aquí (lleva una imagen u otros elementos).'),
      h('label', { for: 'm10-href' }, 'Dirección'), dir,
      h('p', { class: 'nota' }, 'Ejemplos: https://www.ejemplo.com · servicios.html · hola@tuweb.com · +34 600 000 000'),
      error,
      botones(['Cancelar', cerrarPanel], ['Aplicar', () => {
        const href = arreglarHref(dir.value), fallo = hrefInvalido(href);
        if (fallo) { error.textContent = fallo; return; }
        const t = texto ? texto.value.replace(/\s+/g, ' ').trim() : null;
        if (texto && !t) { error.textContent = 'El texto del enlace no puede quedar vacío.'; return; }
        aplicarEnlace(a, t, href);
        cerrarPanel();
      }, true]),
    ]);
  }

  // ─────────────────── 10. Construir el HTML a publicar (sobre el ORIGINAL) ───────────────────
  // Copia el texto editado al elemento original conservando sus etiquetas internas
  // (negritas, enlaces…). Si la estructura cambió, se queda como texto plano con saltos.
  const mismaForma = (a, b) => a.children.length === b.children.length &&
    [...a.children].every((n, i) => n.tagName === b.children[i].tagName && mismaForma(n, b.children[i]));
  // Solo se puede perder formato (negritas, enlaces…); nunca imágenes, iconos u otros elementos
  const FORMATO = /^(B|STRONG|I|EM|U|S|SMALL|MARK|SUB|SUP|SPAN|A|CODE|BR|WBR|ABBR|CITE|Q|TIME)$/;
  const pierdeElementos = (o, v) => !mismaForma(o, v) && [...o.getElementsByTagName('*')].some(n => !FORMATO.test(n.tagName));
  function tramos(el, nodos) { // texto entre etiquetas: antes de la 1ª, entre cada una, tras la última
    const r = [nodos ? [] : ''];
    for (const n of el.childNodes) {
      if (n.nodeType === 1) r.push(nodos ? [] : '');
      else if (n.nodeType === 3) nodos ? r[r.length - 1].push(n) : (r[r.length - 1] += n.data);
    }
    return r;
  }
  function copiarTextos(o, v) {
    const hijos = [...o.children], nuevos = tramos(v), viejos = tramos(o, true);
    viejos.forEach((nodos, i) => {
      const antes = nodos.map(n => n.data).join('');
      let nuevo = nuevos[i];
      if (!antes.includes('\u00a0')) nuevo = nuevo.replace(/\u00a0/g, ' '); // espacios «duros» que mete el navegador
      if (nuevo === antes) return;
      if (nodos.length) { nodos[0].data = nuevo; nodos.slice(1).forEach(n => n.remove()); }
      else if (nuevo) o.insertBefore(o.ownerDocument.createTextNode(nuevo), hijos[i] || null);
    });
    hijos.forEach((n, i) => copiarTextos(n, v.children[i]));
  }
  function lineasDe(el) {
    const lineas = [''];
    (function rec(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) lineas[lineas.length - 1] += c.data.replace(/\u00a0/g, ' ');
        else if (c.nodeName === 'BR') lineas.push('');
        else if (c.nodeType === 1) { if (/^(DIV|P|LI)$/.test(c.nodeName) && lineas[lineas.length - 1].trim()) lineas.push(''); rec(c); }
      }
    })(el);
    while (lineas.length > 1 && !lineas[lineas.length - 1].trim()) lineas.pop();
    return lineas;
  }
  function fusionar(o, vivo) {
    const v = vivo.cloneNode(true);
    v.normalize();
    if (mismaForma(o, v)) return copiarTextos(o, v);
    if (pierdeElementos(o, v)) throw new Error('Un texto ha perdido una imagen o un icono interno. Usa Deshacer. No se ha publicado nada.');
    const doc = o.ownerDocument;
    o.replaceChildren();
    lineasDe(v).forEach((l, i) => { if (i) o.append(doc.createElement('br')); o.append(doc.createTextNode(l)); });
  }

  // Mini-lector de etiquetas: sabe en qué posición del fichero empieza cada etiqueta,
  // para cambiar SOLO esos trozos y dejar el resto del fichero byte a byte igual.
  const CRUDOS = /^(script|style|textarea|title|xmp|iframe|noembed|noframes|template|plaintext)$/;
  function tokenizar(src) {
    const lista = [], n = src.length;
    let i = 0;
    while ((i = src.indexOf('<', i)) >= 0) {
      if (src.startsWith('<!--', i)) { const f = src.indexOf('-->', i + 4); i = f < 0 ? n : f + 3; continue; }
      const m = /^<(\/?)([a-zA-Z][^\s/>]*)/.exec(src.substr(i, 80));
      if (!m) {
        if (/^<[!?/]/.test(src.substr(i, 2))) { const f = src.indexOf('>', i); i = f < 0 ? n : f + 1; } else i++;
        continue;
      }
      let j = i + m[0].length;
      while (j < n && src[j] !== '>') { // respeta los > dentro de valores entre comillas
        if (src[j++] !== '=') continue;
        while (j < n && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q === '"' || q === "'") { const f = src.indexOf(q, j + 1); j = f < 0 ? n : f + 1; }
      }
      const tok = { nombre: m[2].toLowerCase(), cierre: !!m[1], ini: i, fin: Math.min(j + 1, n), auto: src[j - 1] === '/', k: lista.length };
      lista.push(tok);
      i = tok.fin;
      if (!tok.cierre && CRUDOS.test(tok.nombre)) {
        const re = new RegExp('</' + tok.nombre + '[\\s/>]', 'ig');
        re.lastIndex = i;
        const r = re.exec(src);
        i = r ? r.index : n;
      }
    }
    return lista;
  }
  /** Relaciona cada elemento del documento con su etiqueta en el texto. null si no cuadra. */
  function alinear(src, doc) {
    const lista = tokenizar(src), inicios = lista.filter(t => !t.cierre), tokens = new Map();
    let k = 0;
    for (const el of doc.getElementsByTagName('*')) {
      const t = inicios[k], nombre = el.localName.toLowerCase();
      if (t && t.nombre === nombre) { tokens.set(el, t); k++; }
      else if (!/^(html|head|body|tbody|colgroup)$/.test(nombre)) return null; // implícitas: el navegador las crea solas
    }
    return k === inicios.length ? { lista, tokens } : null;
  }
  function cierreDe(lista, t) {
    let prof = 0;
    for (let k = t.k + 1; k < lista.length; k++) {
      const x = lista[k];
      if (x.nombre !== t.nombre) continue;
      if (!x.cierre) { if (!x.auto) prof++; } else if (prof-- === 0) return x.ini;
    }
    return -1;
  }
  function etiquetaInicio(el, auto) {
    let s = '<' + el.localName;
    for (const a of el.attributes) {
      s += ' ' + a.name + (a.value === '' ? '' : '="' + a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\u00a0/g, '&nbsp;') + '"');
    }
    return s + (auto ? ' />' : '>');
  }
  /** Sustituye solo los trozos cambiados en el texto original. */
  function empalmar(src, mapa, cortes, crlf) {
    const eds = [];
    for (const [el, tipo] of cortes) {
      const t = mapa.tokens.get(el);
      if (!t) return null;
      if (tipo === 'quitar') eds.push([t.ini, t.fin, '']);
      else if (tipo === 'etiqueta') eds.push([t.ini, t.fin, etiquetaInicio(el, t.auto)]);
      else { const fin = cierreDe(mapa.lista, t); if (fin < 0) return null; eds.push([t.fin, fin, el.innerHTML]); }
    }
    eds.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const finales = [];
    for (const e of eds) {
      const u = finales[finales.length - 1];
      if (u && e[0] < u[1]) { if (e[1] <= u[1]) continue; return null; } // ya va dentro del trozo anterior
      finales.push(e);
    }
    let out = src;
    for (let k = finales.length - 1; k >= 0; k--) {
      const [ini, fin, r] = finales[k];
      out = out.slice(0, ini) + (crlf ? r.replace(/\r?\n/g, '\r\n') : r) + out.slice(fin);
    }
    return out;
  }
  const canon = d => [...d.childNodes].map(n => (n.nodeType === 10 ? '<!DOCTYPE ' + n.name + '>' : n.nodeType === 8 ? '<!--' + n.data + '-->' : n.outerHTML || '')).join('\n');
  /** Plan B: serializa el documento original completo (conservando el DOCTYPE tal cual). */
  function serializar(doc, crlf) {
    const dt = /^\s*(<!doctype[^>]*>)/i.exec(S.fuente);
    let s = '';
    for (const n of doc.childNodes) {
      if (n.nodeType === 10) s += (dt ? dt[1] : '<!DOCTYPE html>') + '\n';
      else if (n.nodeType === 8) s += '<!--' + n.data + '-->\n';
      else if (n.nodeType === 1) s += n.outerHTML + '\n';
    }
    return crlf ? s.replace(/\r?\n/g, '\r\n') : s;
  }
  /** Última comprobación: nada del editor puede colarse en lo publicado. */
  function revisarSalida(html) {
    const f = S.fuente, mal = [];
    if (/^\s*<!doctype/i.test(f) && !/^\s*<!doctype/i.test(html)) mal.push('falta el DOCTYPE');
    for (const marca of ['contenteditable', 'data-m10=', 'data-m10-modo', 'm10-editor-host', 'm10-editor-estilos', 'blob:']) {
      if (html.includes(marca) && !f.includes(marca)) mal.push(marca);
    }
    if (html.length < f.length * 0.5) mal.push('el resultado es mucho más corto que el original');
    if (mal.length) throw new Error('Publicación cancelada por seguridad (' + mal.join(', ') + '). No se ha cambiado nada.');
  }

  function construirHtml(cambios) {
    const doc = parsear(S.fuente), mapa = alinear(S.fuente, doc), cortes = [];
    for (const [tipo, v] of cambios) {
      const o = resolverRuta(doc, rutaDesdeBody(S.pares.get(v)));
      if (!o || o.tagName !== v.tagName) throw new Error('No he podido localizar un elemento en el HTML original. No se ha publicado nada.');
      if (tipo === 'texto') { fusionar(o, v); cortes.push([o, 'contenido']); continue; }
      if (tipo === 'enlace') o.setAttribute('href', v.getAttribute('href'));
      else if (o.tagName === 'IMG') {
        const n = S.nuevas.get(v);
        if (n) {
          o.setAttribute('src', n.src);
          o.removeAttribute('srcset');
          o.removeAttribute('sizes');
          const w = o.getAttribute('width');
          if (/^\d+$/.test(w || '') && /^\d+$/.test(o.getAttribute('height') || '')) o.setAttribute('height', String(Math.round(+w * n.alto / n.ancho)));
          const pic = pictureDe(o);
          if (pic) for (const s of [...pic.querySelectorAll('source')]) { cortes.push([s, 'quitar']); s.remove(); }
        }
        if (v.getAttribute('alt') !== null) o.setAttribute('alt', v.getAttribute('alt'));
      } else o.setAttribute('style', conFondo(o.getAttribute('style'), S.nuevas.get(v).src));
      cortes.push([o, 'etiqueta']);
    }
    const crlf = /\r\n/.test(S.fuente);
    let html = mapa && empalmar(S.fuente, mapa, cortes, crlf);
    // Comprobación: el resultado «quirúrgico» debe dar exactamente el mismo documento; si no, plan B.
    S.metodo = 'quirurgico';
    if (!html || canon(parsear(html)) !== canon(doc)) { html = serializar(doc, crlf); S.metodo = 'completo'; }
    host.setAttribute('data-metodo', S.metodo);
    revisarSalida(html);
    return (S.bom ? '\ufeff' : '') + html;
  }

  // ─────────────────────────── 11. Publicar ───────────────────────────
  async function subirImagen(n, token) {
    if (n.subida) return;
    const contenido = bytesAB64(new Uint8Array(await n.blob.arrayBuffer()));
    for (let intento = 1; intento <= 3; intento++) {
      const r = await api('PUT', urlContenido(n.rutaRepo), { message: 'Edición web: imagen ' + n.rutaRepo, content: contenido, branch: CFG.rama }, token);
      if (r.ok) { n.subida = true; return; }
      if (r.status !== 422 || intento === 3) throw errorApi(r, 'subir la imagen');
      // 422 = ya existe un fichero con ese nombre: se prueba con -2, -3
      const suf = '-' + (intento + 1);
      n.rutaRepo = n.rutaBase.replace(/(\.[a-z0-9]+)$/i, suf + '$1');
      n.src = n.srcBase.replace(/(\.[a-z0-9]+)$/i, suf + '$1');
    }
  }

  async function publicar() {
    cerrarEdicion();
    if (!S.listo || S.ocupado) return;
    if (!listaCambios().length) return aviso('No hay cambios que publicar.');
    const token = leerToken() || (await pedirToken());
    if (!token) return;
    S.ocupado = true;
    actualizar();
    ponerEstado('publicando');
    aviso('Publicando…', 'info', 0);
    try {
      // 1. ¿Alguien ha cambiado la página en GitHub desde que empezaste? Entonces no se toca nada.
      const actual = await api('GET', urlContenido(S.ruta) + conRama(), null, token);
      if (actual.status === 401) throw errorApi(actual, 'comprobar la página');
      if (actual.ok && actual.datos && actual.datos.sha !== S.sha) return conflicto();
      // 2. Primero las imágenes, cada una con su propia subida
      const cambios = listaCambios();
      for (const [tipo, el] of cambios) if (tipo === 'imagen' && S.nuevas.has(el)) await subirImagen(S.nuevas.get(el), token);
      // 3. Después la página, construida sobre el HTML original
      const html = construirHtml(cambios);
      const r = await api('PUT', urlContenido(S.ruta), {
        message: `Edición web: ${S.ruta} (${plural(cambios.length)})`,
        content: textoAB64(html), sha: S.sha, branch: CFG.rama,
      }, token);
      if (r.status === 409 || r.status === 422) return conflicto();
      if (!r.ok) throw errorApi(r, 'publicar la página');
      publicado(r.datos, html);
    } catch (e) {
      ponerEstado('listo');
      aviso(e.message, 'error', 10000);
    } finally {
      S.ocupado = false;
      actualizar();
    }
  }

  function conflicto() {
    ponerEstado('conflicto');
    abrirPanel('No se ha publicado', [
      h('p', null, 'Alguien cambió la web mientras editabas. Para no borrar su trabajo, no he publicado nada.'),
      h('p', null, 'Recarga la página y vuelve a hacer tus cambios (si quieres, copia antes tus textos).'),
      botones(['Cerrar', cerrarPanel], ['Recargar', () => { S.sinAviso = true; location.reload(); }, true]),
    ]);
  }

  function publicado(datos, html) {
    // El HTML recién publicado pasa a ser el nuevo «original» (se puede seguir editando)
    S.fuente = S.bom ? html.slice(1) : html;
    S.sha = datos.content.sha;
    const nuevoDoc = parsear(S.fuente), pares = new Map(), usados = new Set();
    for (const [v, o] of S.pares) { const n = resolverRuta(nuevoDoc, rutaDesdeBody(o)); if (n) { pares.set(v, n); usados.add(n); } }
    Object.assign(S, { doc: nuevoDoc, pares, usados, pila: [] });
    S.nuevas.clear();
    for (const el of S.tocados) marcar(el, 'c', false);
    S.tocados.clear();
    ponerEstado('publicado');
    aviso('Publicado.', 'ok');
    const commit = datos.commit && datos.commit.html_url;
    const historial = `https://github.com/${CFG.repo}/commits/${encodeURIComponent(CFG.rama)}/${S.ruta.split('/').map(encodeURIComponent).join('/')}`;
    abrirPanel('Publicado', [
      h('p', null, 'Publicado. La web se actualiza en 1-2 minutos.'),
      commit && h('p', null, enlaceExterno(commit, 'Ver el cambio en GitHub')),
      h('p', null, enlaceExterno(historial, 'Historial de esta página')),
      h('p', { class: 'nota' }, 'Desde el historial puedes ver las versiones anteriores y volver atrás si algo no te convence.'),
      botones(['Seguir editando', cerrarPanel, true]),
    ]);
  }

  // ─────────────────────────── 12. Activar y salir ───────────────────────────
  function escuchar() {
    escucha = new AbortController();
    const o = { capture: true, signal: escucha.signal };
    window.addEventListener('click', alClic, o);
    document.addEventListener('focusin', alEnfocar, o);
    document.addEventListener('focusout', e => { if (e.target === enEdicion) cerrarEdicion(); }, o);
    document.addEventListener('input', () => { if (enEdicion) { S.tocados.add(enEdicion); actualizar(); } }, o);
    document.addEventListener('keydown', alTeclear, o);
    document.addEventListener('paste', alPegar, o);
    for (const t of ['dragover', 'drop']) document.addEventListener(t, e => { if (!e.composedPath().includes(host)) e.preventDefault(); }, o);
    document.addEventListener('submit', e => e.preventDefault(), o);
    window.addEventListener('beforeunload', e => { if (!S.sinAviso && listaCambios().length) { e.preventDefault(); e.returnValue = ''; } }, { signal: escucha.signal });
    window.addEventListener('resize', ajustarHueco, { signal: escucha.signal });
  }

  const esperarCarga = () => (document.readyState === 'complete' ? Promise.resolve() : new Promise(r => window.addEventListener('load', r, { once: true })));

  async function activar() {
    if (activo) return;
    activo = true;
    S = {
      modo: null, fuente: '', bom: false, sha: null, ruta: null, doc: null, listo: false, ocupado: false,
      pares: new Map(), usados: new Set(), rol: { t: new Set(), i: new Set(), a: new Set() },
      marcados: new Set(), tocados: new Set(), nuevas: new Map(), pila: [],
      plegada: false, alCerrar: null, sinAviso: false, avisoBloqueo: false,
    };
    montar();
    const sesion = S; // si se sale y se vuelve a entrar mientras carga, esta carga se abandona
    aviso('Cargando la página original desde GitHub…', 'info', 0);
    try {
      if (!/^[\w.-]+\/[\w.-]+$/.test(CFG.repo)) throw new Error('Falta data-repo="DUEÑO/REPO" en la etiqueta <script> del editor.');
      await Promise.all([cargarOriginal(), Promise.race([esperarCarga(), espera(8000)])]);
      await espera(300); // margen para lo que la web pinta justo al cargar
      if (!activo || S !== sesion) return;
      prepararElementos();
      obs = new MutationObserver(alMutar);
      obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['src', 'srcset', 'href'] });
      escuchar();
      S.listo = true;
      habilitar(true);
      cambiarModo('textos');
      actualizar();
      ponerEstado('listo');
      aviso(`Modo edición: ${S.rol.t.size} textos, ${S.rol.i.size} imágenes y ${S.rol.a.size} enlaces editables. Haz clic en un texto para cambiarlo.`, 'ok', 6000);
    } catch (e) {
      if (!activo || S !== sesion) return;
      ponerEstado('error');
      ui.aviso.hidden = true;
      abrirPanel('No se puede editar', [
        h('p', null, e.message),
        botones(e.pedirToken && ['Poner token', async () => { if (await pedirToken()) { desmontar(); activar(); } }],
          ['Salir', () => desmontar(), true]),
      ]);
    }
  }

  function salir(descartar) {
    if (!activo) return;
    cerrarEdicion();
    const n = listaCambios().length;
    if (n && !descartar) {
      return abrirPanel('¿Salir sin publicar?', [
        h('p', null, `Tienes ${plural(n)} sin publicar. Si sales, se pierden.`),
        botones(['Salir sin publicar', () => salir(true)], ['Seguir editando', cerrarPanel, true]),
      ]);
    }
    if (n) { S.sinAviso = true; quitarHash(); location.reload(); return; } // vuelve la página tal cual estaba
    desmontar();
  }

  /** Deja la página exactamente como estaba antes de activar. */
  function desmontar() {
    if (obs) obs.disconnect();
    if (escucha) escucha.abort();
    obs = escucha = enEdicion = null;
    for (const el of S.marcados) { el.removeAttribute('data-m10'); el.removeAttribute('contenteditable'); }
    document.documentElement.removeAttribute('data-m10-modo');
    S.estiloBody === null ? document.body.removeAttribute('style') : document.body.setAttribute('style', S.estiloBody);
    if (host) host.remove();
    if (hojaPagina) hojaPagina.remove();
    host = hojaPagina = null;
    ui = {};
    activo = false;
    quitarHash();
  }
  function quitarHash() {
    if (/^#editar$/i.test(location.hash)) history.replaceState(history.state, '', location.pathname + location.search);
  }

  // Lo único que hace el editor sin activar: escuchar el atajo y #editar.
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.code === 'KeyE' || /^e$/i.test(e.key))) {
      e.preventDefault();
      activo ? salir(false) : activar();
    }
  });
  window.addEventListener('hashchange', () => { if (/^#editar$/i.test(location.hash)) activar(); });
  if (/^#editar$/i.test(location.hash)) activar();

  window.M10Editor = { version: '1.0', activar, salir: () => salir(false), _rutasPagina: rutasPagina };
})();
