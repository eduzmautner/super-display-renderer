// ============================================================================
// Super Display Renderer — renderer module
//
// Owns everything 3D: the Three.js scene, the canonical `state`, geometry
// generation (build / buildDims / the box dieline), the cameras + orbit, the
// dimension-callout overlay, the box-count badge, the UV editor's canvas
// drawing + interaction, and PNG rendering.
//
// It exposes ONE entry point — SDR.init(container, opts) — which returns a
// small explicit API. The UI (index.html) talks to that API and never reaches
// into these internals; the renderer talks back only through the opts
// callbacks (onFitWarning / onCameraChange / onViewChange). Neither side
// matches the other's DOM element IDs by convention.
// ============================================================================
window.SDR = (function(){

function init(container, opts){
  opts = opts || {};
  const emit = {
    fitWarning:   opts.onFitWarning   || function(){},
    cameraChange: opts.onCameraChange || function(){},
    viewChange:   opts.onViewChange   || function(){}
  };

  // ============ units & dimensions ============
  // All dimensions are stored canonically in INCHES. The mm/in toggle only
  // re-scales slider bounds and readouts, so switching units never alters the
  // geometry.
  const MM_PER_IN = 25.4;
  const UNITS = {
    mm: {label:'mm', factor:MM_PER_IN, step:1,    dec:0},
    in: {label:'in', factor:1,         step:0.25, dec:2}
  };
  const mm = v => v / MM_PER_IN;   // mm -> canonical inches

  const DIM_BOUNDS = {                        // stored in inches
    dh: [mm(1000), mm(1200)],                 // display height, header excluded
    hh: [mm(150),  mm(250)],                  // header height
    bw: [1, 12],
    bh: [1, 16],
    bd: [1, 12],
    pad:     [mm(0), mm(150)],                   // extra width added to EACH side
    backPad: [mm(0), mm(300)],                   // extra depth added behind the products
    st:      [mm(2), mm(30)]                      // tray height (shelf thickness)
  };
  const DIM_KEYS = Object.keys(DIM_BOUNDS);
  const TYPEABLE = ['dh','hh','bw','bh','bd','pad','backPad','st'];
  const WORLD = 0.1;                // 1 inch = 0.1 world units
  const TIER_GAP_MM = 2;            // clearance between a box top and the shelf above it

  const SLOTS = [
    {key:'displayFront',  label:'Display<br>Front'},
    {key:'displaySide',   label:'Display<br>Side'},
    {key:'displayHeader', label:'Display<br>Header'}
  ];

  // Canonical defaults live in one place so init and reset() can't drift.
  function freshState(){
    return {
      tiers:3, cols:3, rows:4,
      dh: mm(1016),
      hh: mm(200),
      bw:4, bh:5.5, bd:3, pad:0, backPad:0, st:mm(6),
      header:true,
      unit:'mm',
      // Box artwork: a single flat dieline image, placed on the cross by the UV
      // editor. cx/cy/iw are in dieline inches (y measured DOWN from the top).
      boxArt: {img:null, cx:0, cy:0, iw:0, rot:0},
      cStand:'#050505', cShelf:'#0a0a0a', cPad:'#afafaf',
      focal:100, camY:50, view:'iso', exportSize:1500,
      showDims:true,
      tex:{}
    };
  }
  const state = freshState();
  let built = false;

  // ============ three setup ============
  const renderer = new THREE.WebGLRenderer({antialias:true, preserveDrawingBuffer:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  container.appendChild(renderer.domElement);

  // Render-coupled overlays the renderer owns and positions each frame. Created
  // here (not read from the page) so the module carries no dependency on the
  // host markup's element IDs.
  const dimOverlay = document.createElement('div');
  dimOverlay.id = 'dimOverlay';
  container.appendChild(dimOverlay);

  const boxCountEl = document.createElement('div');
  boxCountEl.id = 'boxCount';
  boxCountEl.textContent = 'Total items: 0';
  container.appendChild(boxCountEl);

  const BG = new THREE.Color(0xffffff);
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  scene.add(group);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 0.6));
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const key = new THREE.DirectionalLight(0xffffff, 0.85);
  key.position.set(5, 9, 7);
  key.castShadow = true;
  key.shadow.mapSize.set(2048,2048);
  Object.assign(key.shadow.camera, {left:-8, right:8, top:8, bottom:-8});
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.3);
  fill.position.set(-6, 4, -5);
  scene.add(fill);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(120,120),
    new THREE.MeshStandardMaterial({color:0xffffff, roughness:.95}));
  floor.rotation.x = -Math.PI/2;
  floor.receiveShadow = true;
  scene.add(floor);

  function fovFromFocal(mm){ return 2 * Math.atan(12 / mm) * 180 / Math.PI; }

  const perspCam = new THREE.PerspectiveCamera(fovFromFocal(state.focal), 1, 0.1, 600);
  const orthoCam = new THREE.OrthographicCamera(-1,1,1,-1,0.1,600);
  let activeCam = perspCam;

  const orbit = {az:-0.60, pol:1.40, r:9, target:new THREE.Vector3()};
  const ORBIT_DEFAULT = {az:-0.60, pol:1.40};   // camY + fitRadius supply the rest on reset

  // Camera-angle slider maps to the polar (pitch) angle. POL_MIN looks down from
  // above, POL_MAX looks up at the products. Slider and drag share this range so
  // they stay in sync.
  const POL_MIN = 0.35, POL_MAX = 1.62;
  const polToSlider = p => Math.round((p - POL_MIN) / (POL_MAX - POL_MIN) * 100);
  const sliderToPol = v => POL_MIN + (v/100) * (POL_MAX - POL_MIN);
  function angleSliderValue(){ return Math.max(0, Math.min(100, polToSlider(orbit.pol))); }

  function applyOrbit(){
    perspCam.position.set(
      orbit.target.x + orbit.r*Math.sin(orbit.pol)*Math.sin(orbit.az),
      orbit.target.y + orbit.r*Math.cos(orbit.pol),
      orbit.target.z + orbit.r*Math.sin(orbit.pol)*Math.cos(orbit.az)
    );
    perspCam.lookAt(orbit.target);
  }

  let drag=false, lx=0, ly=0;
  renderer.domElement.addEventListener('pointerdown', e=>{
    if(state.view!=='iso') return; drag=true; lx=e.clientX; ly=e.clientY;
  });
  addEventListener('pointerup', ()=> drag=false);
  addEventListener('pointermove', e=>{
    if(!drag) return;
    orbit.az -= (e.clientX-lx)*0.006;
    orbit.pol = Math.min(POL_MAX, Math.max(POL_MIN, orbit.pol - (e.clientY-ly)*0.006));
    lx=e.clientX; ly=e.clientY;
    applyOrbit();
    emit.cameraChange(angleSliderValue());
  });
  renderer.domElement.addEventListener('wheel', e=>{
    if(state.view!=='iso') return;
    e.preventDefault();
    const base = fitRadius();
    orbit.r = Math.min(base*2.5, Math.max(base*0.35, orbit.r * (1 + e.deltaY*0.0012)));
    applyOrbit();
  }, {passive:false});

  // ============ textures ============
  const phCache = {};
  function placeholder(label, w, h){
    const id = label+w+h;
    if(phCache[id]) return phCache[id];
    const c = document.createElement('canvas');
    c.width=w; c.height=h;
    const x = c.getContext('2d');
    x.fillStyle='#26282e'; x.fillRect(0,0,w,h);
    x.strokeStyle='#3f434c'; x.lineWidth=Math.max(4, w*0.012);
    x.setLineDash([w*0.04, w*0.03]);
    x.strokeRect(w*0.05, h*0.05, w*0.9, h*0.9);
    x.setLineDash([]);
    x.fillStyle='#6c717c';
    x.textAlign='center'; x.textBaseline='middle';
    x.font='600 '+Math.round(Math.min(w,h)*0.075)+'px sans-serif';
    x.fillText(label.toUpperCase(), w/2, h/2);
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    phCache[id]=t;
    return t;
  }
  function matFor(slotKey, phLabel, phW, phH){
    return new THREE.MeshStandardMaterial({
      map: state.tex[slotKey] || placeholder(phLabel, phW, phH),
      roughness: 0.72
    });
  }

  // ============ box dieline (cross unwrap) ============
  // The flat is the standard six-panel cross:
  //
  //            +--------+
  //            |  Top   |
  //   +--------+--------+--------+--------+
  //   | L Side | Front  | R Side |  Back  |
  //   +--------+--------+--------+--------+
  //            | Bottom |
  //            +--------+
  //
  // Rather than transforming UVs when the artwork moves, the artwork is BAKED
  // into a canvas laid out as this cross. That canvas is the texture; the box
  // UVs map each face to its rectangle in the cross and never change. So "where
  // does the image sit on the dieline" is the only thing the UV editor answers.

  function dielineLayout(bw, bh, bd){
    const W = 2*bd + 2*bw;
    const H = bh + 2*bd;
    // rects in dieline inches, y measured DOWN from the top edge of the flat
    return {
      W, H,
      faces: {
        top:    [bd,        0,        bd+bw,      bd        ],
        lside:  [0,         bd,       bd,         bd+bh     ],
        front:  [bd,        bd,       bd+bw,      bd+bh     ],
        rside:  [bd+bw,     bd,       2*bd+bw,    bd+bh     ],
        back:   [2*bd+bw,   bd,       2*bd+2*bw,  bd+bh     ],
        bottom: [bd,        bd+bh,    bd+bw,      bd+bh+bd  ]
      }
    };
  }

  // BoxGeometry emits faces in the order +x, -x, +y, -y, +z, -z, four vertices
  // each, and its default per-face UVs already read correctly from outside. So
  // each face's unit square just needs remapping into its rectangle on the
  // cross - no flips required.
  const FACE_ORDER = ['rside','lside','top','bottom','front','back'];

  function applyDielineUVs(geo, bw, bh, bd){
    const L = dielineLayout(bw, bh, bd);
    const uv = geo.attributes.uv;

    for(let f = 0; f < 6; f++){
      const [x0, y0, x1, y1] = L.faces[FACE_ORDER[f]];
      const u0 = x0 / L.W, u1 = x1 / L.W;
      const v0 = 1 - (y1 / L.H), v1 = 1 - (y0 / L.H);   // canvas y-down -> texture v-up

      for(let i = 0; i < 4; i++){
        const idx = f*4 + i;
        const du = uv.getX(idx), dv = uv.getY(idx);      // 0 or 1
        uv.setXY(idx, u0 + du*(u1 - u0), v0 + dv*(v1 - v0));
      }
    }
    uv.needsUpdate = true;
  }

  // Fit the artwork inside the flat, centred. Used on upload and by Fit button.
  function fitArtwork(art, L){
    if(!art.img) return;
    const ar = art.img.naturalWidth / art.img.naturalHeight;
    art.iw  = Math.min(L.W, L.H * ar);
    art.cx  = L.W/2;
    art.cy  = L.H/2;
    art.rot = 0;
  }

  const DIELINE_PX = 1800;
  let dielineTex = null, dielineKey = '';

  function bakeDieline(bw, bh, bd, art){
    const L = dielineLayout(bw, bh, bd);
    const ppi = DIELINE_PX / Math.max(L.W, L.H);
    const c = document.createElement('canvas');
    c.width  = Math.round(L.W * ppi);
    c.height = Math.round(L.H * ppi);
    const x = c.getContext('2d');

    x.fillStyle = '#26282e';
    x.fillRect(0, 0, c.width, c.height);

    if(art.img){
      const ih = art.iw / (art.img.naturalWidth / art.img.naturalHeight);
      x.save();
      x.translate(art.cx*ppi, art.cy*ppi);
      x.rotate(art.rot);
      x.drawImage(art.img, -art.iw*ppi/2, -ih*ppi/2, art.iw*ppi, ih*ppi);
      x.restore();
    } else {
      // no artwork yet: draw the flat itself so the boxes still read as boxes
      x.strokeStyle = '#3f434c';
      x.lineWidth = Math.max(2, ppi*0.03);
      x.fillStyle = '#6c717c';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.font = '600 ' + Math.round(ppi*0.42) + 'px sans-serif';
      for(const [name, r] of Object.entries(L.faces)){
        const [x0,y0,x1,y1] = r.map(v => v*ppi);
        x.strokeRect(x0, y0, x1-x0, y1-y0);
        x.fillText(name.toUpperCase(), (x0+x1)/2, (y0+y1)/2);
      }
    }

    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    t.anisotropy = 8;
    return t;
  }

  function dielineTexture(){
    const a = state.boxArt;
    const key = [state.bw, state.bh, state.bd, a.img ? a.img.src.length : 0,
                 a.cx, a.cy, a.iw, a.rot].join('|');
    if(key !== dielineKey || !dielineTex){
      if(dielineTex) dielineTex.dispose();
      dielineTex = bakeDieline(state.bw, state.bh, state.bd, a);
      dielineKey = key;
    }
    return dielineTex;
  }

  // ============ dimension callouts ============
  // These live in their own group so they can be switched off for export
  // without disturbing the display geometry. depthTest is disabled so callouts
  // always draw on top of the model and the floor rather than being clipped.
  const dimGroup = new THREE.Group();
  dimGroup.renderOrder = 999;
  scene.add(dimGroup);

  const DIM_COLOR = 0x1f6feb;

  function formatDim(inches){
    const u = UNITS[state.unit];
    return (inches * u.factor).toFixed(u.dec) + ' ' + u.label;
  }

  function dimLines(points){
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    const mat = new THREE.LineBasicMaterial({
      color: DIM_COLOR, depthTest:false, depthWrite:false, transparent:true
    });
    const l = new THREE.LineSegments(geo, mat);
    l.renderOrder = 999;
    return l;
  }

  // Dimension labels are real HTML elements overlaid on the viewport, not baked
  // textures. The browser renders the text and pill natively, so they stay
  // crisp at any zoom and match the rest of the UI. Each frame their world
  // anchor is projected to screen coordinates.
  let htmlLabels = [];      // { el, pos: THREE.Vector3 }

  function dimLabel(text, pos){
    const el = document.createElement('div');
    el.className = 'dim-label';
    el.textContent = text;
    dimOverlay.appendChild(el);
    htmlLabels.push({el, pos: pos.clone()});
  }

  const _proj = new THREE.Vector3();
  function updateLabelScreen(){
    if(!htmlLabels.length) return;
    const show = dimGroup.visible;
    const cv = renderer.domElement;
    const vp = container.getBoundingClientRect();
    const cr = cv.getBoundingClientRect();
    const offX = cr.left - vp.left, offY = cr.top - vp.top;
    const w = cv.clientWidth, h = cv.clientHeight;

    for(const {el, pos} of htmlLabels){
      if(!show){ el.style.display = 'none'; continue; }
      _proj.copy(pos).project(activeCam);
      // behind the perspective camera -> hide
      if(activeCam === perspCam && _proj.z > 1){ el.style.display = 'none'; continue; }
      el.style.display = '';
      const x = ( _proj.x * 0.5 + 0.5) * w + offX;
      const y = (-_proj.y * 0.5 + 0.5) * h + offY;
      el.style.transform = 'translate(-50%,-50%) translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
    }
  }

  function buildDims(standW, standH, standD){
    while(dimGroup.children.length) dimGroup.remove(dimGroup.children[0]);
    dimOverlay.innerHTML = '';
    htmlLabels = [];
    dimGroup.visible = state.showDims;

    const hw = standW/2, hd = standD/2;
    const off  = Math.max(0.32, standW*0.24);   // how far callouts sit off the model
    const tick = off*0.30;

    const gy   = 0.004;                          // a hair above the floor plane

    const xL = -hw - off;                        // left datum line (ground + height)
    const zF =  hd + off;                        // front datum line (ground)

    const pts = [];
    const seg = (a,b)=> pts.push(a[0],a[1],a[2], b[0],b[1],b[2]);

    // ---- WIDTH: lies FLAT on the ground plane, in front of the display ----
    seg([-hw, gy, zF], [hw, gy, zF]);
    seg([-hw, gy,  hd], [-hw, gy, zF + tick*0.5]);      // extension lines, front corners out
    seg([ hw, gy,  hd], [ hw, gy, zF + tick*0.5]);
    seg([-hw, gy, zF + tick*0.5], [-hw + tick, gy, zF - tick*0.5]);   // ticks, in-plane
    seg([ hw, gy, zF + tick*0.5], [ hw - tick, gy, zF - tick*0.5]);

    // ---- DEPTH: also FLAT on the ground, alongside the display ----
    seg([xL, gy, -hd], [xL, gy, hd]);
    seg([-hw, gy, -hd], [xL - tick*0.5, gy, -hd]);      // extension lines, left corners out
    seg([-hw, gy,  hd], [xL - tick*0.5, gy,  hd]);
    seg([xL - tick*0.5, gy, -hd], [xL + tick*0.5, gy, -hd + tick]);
    seg([xL - tick*0.5, gy,  hd], [xL + tick*0.5, gy,  hd - tick]);

    // ---- HEIGHT: vertical, on the BACK edge, clear of the display silhouette ----
    seg([xL, 0, -hd], [xL, standH, -hd]);
    seg([-hw, 0,      -hd], [xL - tick*0.5, 0,      -hd]);   // extension lines to back corners
    seg([-hw, standH, -hd], [xL - tick*0.5, standH, -hd]);
    seg([xL - tick*0.5, 0,      -hd], [xL + tick*0.5, tick,          -hd]);
    seg([xL - tick*0.5, standH, -hd], [xL + tick*0.5, standH - tick, -hd]);

    dimGroup.add(dimLines(pts));

    dimLabel(formatDim(standW/WORLD),
      new THREE.Vector3(0, gy, zF + off*0.75));                  // in front, on the ground
    dimLabel(formatDim(standD/WORLD),
      new THREE.Vector3(xL - off*0.70, gy, 0));                  // alongside, on the ground
    dimLabel(formatDim(standH/WORLD),
      new THREE.Vector3(xL - off*0.70, standH/2, -hd));          // back edge, mid-height

    updateLabelScreen();
  }

  // ============ build ============
  let bounds = {w:0,h:0,d:0};

  function build(){
    while(group.children.length) group.remove(group.children[0]);

    const standH = state.dh * WORLD;          // fixed, header excluded
    const headerH = state.header ? state.hh * WORLD : 0;
    const bw = state.bw*WORLD, bh = state.bh*WORLD, bd = state.bd*WORLD;
    const gapX = bw*0.06, gapZ = bd*0.05;
    const {cols, rows, tiers} = state;

    const blockW = cols*bw + (cols-1)*gapX;     // width of the product block itself
    const pad    = state.pad * WORLD;           // extra width added to EACH side
    const shelfW = blockW + pad*2;              // shelf/interior span including side padding
    const showSideFiller = (state.pad * MM_PER_IN) > 10;

    const blockD  = rows*bd + (rows-1)*gapZ;    // depth of the product block itself
    const backPad = state.backPad * WORLD;      // extra depth added BEHIND the products
    const shelfD  = blockD + backPad;           // interior depth including back padding
    const showBackFiller = (state.backPad * MM_PER_IN) > 10;
    const wallT  = 0.05;
    const panelT = wallT * 0.5;                 // side panels + header: 50% thinner
    const standW = shelfW + panelT*2 + 0.06;
    const standD = shelfD + 0.12;
    const trayH  = state.st * WORLD;            // full tray value (slider-controlled)
    const showTray = (state.st * MM_PER_IN) > 6;   // above 6 mm the shelf becomes a walled tray
    // Flat mode: the slab is the whole value. Tray mode: the floor caps at 6 mm
    // and the extra height goes into the walls, so the base doesn't keep
    // thickening.
    const shelfT = showTray ? mm(6)*WORLD : trayH;

    // Display height is FIXED. Tiers are packed from the top down at their
    // preferred pitch, and whatever height is left over below becomes the front
    // cabinet panel. Tier pitch is shelf + box + a fixed 2 mm clearance, not a
    // percentage of box height. Real displays run the boxes almost flush to the
    // shelf above.
    const gap = mm(TIER_GAP_MM) * WORLD;
    const wantPitch = bh + shelfT + gap;
    const tierPitch = Math.min(wantPitch, standH / tiers);   // compress only if forced
    const baseH     = Math.max(0, standH - tiers*tierPitch);
    const topY      = standH;
    const totalH    = standH + headerH;

    // warn if the boxes physically can't fit the compressed pitch
    const need = bh + shelfT;
    if(tierPitch < need){
      const overMm = ((need - tierPitch) / WORLD * MM_PER_IN).toFixed(0);
      emit.fitWarning(tiers + ' tiers do not fit in this display height. Boxes overlap the shelf above by about ' + overMm + ' mm. Reduce tiers, lower box height, or raise display height.');
    } else {
      emit.fitWarning(null);
    }

    bounds = {w:standW, h:totalH, d:standD};

    const standMat = new THREE.MeshStandardMaterial({color:state.cStand, roughness:.6});
    const shelfMat = new THREE.MeshStandardMaterial({color:state.cShelf, roughness:.65});
    const padMat   = new THREE.MeshStandardMaterial({color:state.cPad,   roughness:.65});
    const darkMat  = new THREE.MeshStandardMaterial({color:0x1b1c20, roughness:.85});

    // ---- side panels ----
    // Profile drawn in local XY: x = display depth (0 at FRONT), y = height.
    //
    // Die-line constraint: unfolded, the front panel and the two side panels
    // share a fold. So the side panel's SHORT (front) edge is the same edge as
    // the top of the front panel and must be exactly as tall. The wedge then
    // slopes up from there to full stand height at the back. frontTopY is
    // therefore not a free variable - it is baseH, whatever the tier count has
    // driven baseH to.
    const frontTopY = baseH;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(standD, 0);
    shape.lineTo(standD, topY);
    shape.lineTo(0, frontTopY);
    shape.lineTo(0, 0);

    const sideGeo = new THREE.ExtrudeGeometry(shape, {depth: panelT, bevelEnabled:false});
    sideGeo.computeBoundingBox();
    const bb = sideGeo.boundingBox;
    const pos = sideGeo.attributes.position, uvA = sideGeo.attributes.uv;
    for(let i=0;i<pos.count;i++){
      uvA.setXY(i,
        (pos.getX(i)-bb.min.x)/(bb.max.x-bb.min.x),   // u: 0 = display front
        (pos.getY(i)-bb.min.y)/(bb.max.y-bb.min.y)    // v: 0 = floor
      );
    }
    uvA.needsUpdate = true;

    // Both panels are rotated +90 deg about Y, so the extrude's front cap (+Z
    // local) ends up facing world +X. That cap is the OUTWARD face of the RIGHT
    // panel and the INWARD face of the LEFT panel. A viewer standing off the
    // left side therefore reads the geometry's back cap, which runs
    // right-to-left on screen and shows the art mirrored. Flipping U on the
    // left panel's own copy cancels that out, so the artwork reads correctly
    // from whichever side is facing camera.
    function flippedU(geo){
      const g = geo.clone();
      const uv = g.attributes.uv;
      for(let i=0;i<uv.count;i++) uv.setX(i, 1 - uv.getX(i));
      uv.needsUpdate = true;
      return g;
    }

    // ExtrudeGeometry emits two material groups: index 0 = the flat cap faces,
    // index 1 = the walls swept around the profile edge. Previously one material
    // covered both, so the planar UVs smeared the artwork around the panel's
    // thickness. Feeding an array keeps the art on the caps and paints the edge
    // walls in the display body colour.
    const sideMats  = [matFor('displaySide','display side',700,900), standMat];
    const sideMatsL = [matFor('displaySide','display side',700,900), standMat];

    const sideL = new THREE.Mesh(flippedU(sideGeo), sideMatsL);
    sideL.rotation.y = Math.PI/2;
    sideL.position.set(-standW/2, 0, standD/2);
    sideL.castShadow = sideL.receiveShadow = true;
    group.add(sideL);

    const sideR = new THREE.Mesh(sideGeo, sideMats);
    sideR.rotation.y = Math.PI/2;
    sideR.position.set(standW/2 - panelT, 0, standD/2);
    sideR.castShadow = sideR.receiveShadow = true;
    group.add(sideR);

    // ---- front cabinet panel (height varies with tier count) ----
    if(baseH > 0.005){
      const frontMats = [darkMat,darkMat,darkMat,darkMat, matFor('displayFront','display front',800,600), darkMat];
      const frontPanel = new THREE.Mesh(new THREE.BoxGeometry(standW - panelT*2, baseH, wallT), frontMats);
      frontPanel.position.set(0, baseH/2, standD/2 - wallT/2);
      frontPanel.castShadow = frontPanel.receiveShadow = true;
      group.add(frontPanel);
    }

    // ---- back panel ----
    const back = new THREE.Mesh(new THREE.BoxGeometry(standW - panelT*2, topY, wallT), standMat);
    back.position.set(0, topY/2, -standD/2 + wallT/2);
    back.castShadow = back.receiveShadow = true;
    group.add(back);

    // ---- header (optional) ----
    if(state.header){
      const headerMats = [standMat,standMat,standMat,standMat, matFor('displayHeader','display header',1400,500), standMat];
      const header = new THREE.Mesh(new THREE.BoxGeometry(standW, headerH, panelT), headerMats);
      header.position.set(0, topY + headerH/2, -standD/2 + panelT/2);
      header.castShadow = true;
      group.add(header);
    }

    // ---- shelves + product ----
    const boxMat = new THREE.MeshStandardMaterial({map: dielineTexture(), roughness:0.72});
    const boxGeo = new THREE.BoxGeometry(bw, bh, bd);
    applyDielineUVs(boxGeo, state.bw, state.bh, state.bd);

    for(let t=0; t<tiers; t++){
      const shelfY = baseH + t*tierPitch + shelfT/2;
      // Front lip protrudes a fixed 3 mm past the product front; back edge meets
      // the back panel. Depth is derived from those two anchors rather than the
      // interior span, so the overhang stays constant no matter how deep the
      // display gets.
      const shelfFrontZ = shelfD/2 + mm(3)*WORLD;
      const shelfBackZ  = -standD/2 + wallT;
      const shelfDepth  = shelfFrontZ - shelfBackZ;
      const shelf = new THREE.Mesh(new THREE.BoxGeometry(standW - panelT*2, shelfT, shelfDepth), shelfMat);
      shelf.position.set(0, shelfY, (shelfFrontZ + shelfBackZ)/2);
      shelf.castShadow = shelf.receiveShadow = true;
      group.add(shelf);

      // Tray walls: above 6 mm, the shelf becomes a tray whose walls wrap the
      // interior, rising from the shelf's top surface (the box-bottom plane) by
      // the tray height. They sit in the existing margin between the
      // product+padding block and the shelf edge, so no extra footprint is
      // needed. Height stays well under the box height, so tier pitch is
      // unaffected.
      if(showTray){
        const wallH   = trayH;                           // walls as tall as the full tray value
        const wallBaseY = shelfY + shelfT/2;             // top surface of the shelf floor
        const wallY   = wallBaseY + wallH/2;
        const innerHalfW = shelfW/2;                     // product + side padding edge
        const outerHalfW = (standW - panelT*2)/2;        // shelf edge
        const wallThk = outerHalfW - innerHalfW;         // the 3 mm margin
        const sideDepth = shelfFrontZ - shelfBackZ;      // full tray depth
        const sideMidZ  = (shelfFrontZ + shelfBackZ)/2;

        // left + right walls
        for(const side of [-1, 1]){
          const w = new THREE.Mesh(new THREE.BoxGeometry(wallThk, wallH, sideDepth), shelfMat);
          w.position.set(side * (innerHalfW + wallThk/2), wallY, sideMidZ);
          w.castShadow = w.receiveShadow = true;
          group.add(w);
        }
        // front lip: spans the full shelf width, sits in the front overhang
        const frontDepth = shelfFrontZ - shelfD/2;
        const frontLip = new THREE.Mesh(new THREE.BoxGeometry(outerHalfW*2, wallH, frontDepth), shelfMat);
        frontLip.position.set(0, wallY, (shelfFrontZ + shelfD/2)/2);
        frontLip.castShadow = frontLip.receiveShadow = true;
        group.add(frontLip);

        // back wall: just inside the back panel, closing the tray
        const backDepth = mm(3)*WORLD;
        const backWall = new THREE.Mesh(new THREE.BoxGeometry(outerHalfW*2, wallH, backDepth), shelfMat);
        backWall.position.set(0, wallY, shelfBackZ + backDepth/2);
        backWall.castShadow = backWall.receiveShadow = true;
        group.add(backWall);
      }

      for(let r=0;r<rows;r++){
        for(let c=0;c<cols;c++){
          const m = new THREE.Mesh(boxGeo, boxMat);
          m.position.set(
            -blockW/2 + bw/2 + c*(bw+gapX),
            shelfY + shelfT/2 + bh/2,
            shelfD/2 - bd/2 - r*(bd+gapZ)
          );
          m.castShadow = m.receiveShadow = true;
          group.add(m);
        }
      }

      // Filler blocks close the padded gaps with shelf-coloured mass once a gap
      // exceeds 10 mm. Side fillers only span the PRODUCT depth, so when a back
      // filler is also present the back slab runs the full width behind them and
      // nothing overlaps.
      const boxTopY = shelfY + shelfT/2 + bh/2;
      const blockFrontZ = shelfD/2;                    // front face of the product block
      const blockMidZ   = blockFrontZ - blockD/2;      // centre of the product depth

      if(showSideFiller){
        for(const side of [-1, 1]){
          const filler = new THREE.Mesh(new THREE.BoxGeometry(pad, bh, blockD), padMat);
          filler.position.set(side * (blockW/2 + pad/2), boxTopY, blockMidZ);
          filler.castShadow = filler.receiveShadow = true;
          group.add(filler);
        }
      }

      if(showBackFiller){
        // Spans the FULL interior width (products + side padding) and fills the
        // depth behind the product block, from the back of the products to the
        // display back.
        const backFiller = new THREE.Mesh(new THREE.BoxGeometry(shelfW, bh, backPad), padMat);
        backFiller.position.set(0, boxTopY, blockFrontZ - blockD - backPad/2);
        backFiller.castShadow = backFiller.receiveShadow = true;
        group.add(backFiller);
      }
    }

    const boxTotal = cols * rows * tiers;
    boxCountEl.textContent = 'Total items: ' + boxTotal;

    buildDims(standW, standH, standD);
    updateProjection();
  }

  // ============ cameras ============
  // Keep this breakpoint in step with the CSS @media (max-width:768px) that
  // switches the layout to the stacked/full-bleed mobile mode.
  const mobileMQ = window.matchMedia('(max-width: 768px)');
  function stageSize(){
    // Desktop insets the square canvas so it reads as a floating card; mobile
    // goes full-bleed, filling the smaller frame dimension edge-to-edge.
    const inset = mobileMQ.matches ? 0 : 48;
    return Math.max(240, Math.min(container.clientWidth, container.clientHeight) - inset);
  }
  function fitRadius(){
    const fov = fovFromFocal(state.focal) * Math.PI / 180;
    const half = Math.sqrt(bounds.w**2 + bounds.h**2 + bounds.d**2) / 2;
    return (half / Math.tan(fov/2)) * 1.08;
  }
  // Projection + ortho framing only. Safe to call on every rebuild: it never
  // touches the perspective orbit distance, so zooming in and then editing
  // geometry keeps your zoom.
  function updateProjection(){
    const half = Math.max(bounds.w/2 * 1.18, bounds.h/2 * 1.08);
    orthoCam.left=-half; orthoCam.right=half; orthoCam.top=half; orthoCam.bottom=-half;
    orthoCam.position.set(0, bounds.h/2, 100);
    orthoCam.lookAt(0, bounds.h/2, 0);
    orthoCam.updateProjectionMatrix();

    perspCam.aspect = 1;
    perspCam.fov = fovFromFocal(state.focal);
    perspCam.updateProjectionMatrix();
    applyOrbit();
  }

  // Full reframe: recentres and resets the orbit distance so the whole display
  // fits. Only called on load, on window resize, and by the Reset camera button
  // - never on slider edits.
  function fitCameras(){
    updateProjection();
    orbit.target.set(0, bounds.h * (state.camY/100), 0);
    orbit.r = fitRadius();
    applyOrbit();
  }
  function positionBoxCount(){
    const cv = renderer.domElement;
    const vp = container.getBoundingClientRect();
    const cr = cv.getBoundingClientRect();
    const inset = 14;
    boxCountEl.style.left = (cr.left - vp.left + inset) + 'px';
    boxCountEl.style.top  = (cr.top  - vp.top  + inset) + 'px';
  }

  function resize(){
    const s = stageSize();
    renderer.setSize(s, s, true);
    fitCameras();
    positionBoxCount();
  }
  addEventListener('resize', resize);

  function loop(){
    requestAnimationFrame(loop);
    scene.background = BG;
    renderer.render(scene, activeCam);
    updateLabelScreen();
  }

  // ============ UV editor ============
  const uvCanvas = opts.uvCanvas;
  const uvCtx = uvCanvas ? uvCanvas.getContext('2d') : null;

  const CW = 936, CH = 564, PAD = 46;
  let draft = null;            // working copy of boxArt; discarded on Cancel
  let uvOpacity = 0.7;
  let view = {s:1, ox:0, oy:0};
  let uvDrag = null;

  // Touch devices get fatter hit targets and handles so the gumball is usable
  // with a fingertip rather than a mouse cursor.
  const COARSE = !!(window.matchMedia && window.matchMedia('(pointer:coarse)').matches);
  const CORNER_HIT = COARSE ? 18 : 9;    // px radius to grab a scale handle
  const ROT_HIT    = COARSE ? 20 : 10;   // px radius to grab the rotate knob
  const HANDLE_HALF= COARSE ? 8  : 4;    // half-size of the drawn scale squares
  const KNOB_R     = COARSE ? 9  : 5;    // drawn rotate knob radius
  const ROT_STEM   = COARSE ? 34 : 26;   // rotate stem length, px

  function sizeUvCanvas(){
    const dpr = Math.min(devicePixelRatio, 2);
    uvCanvas.width = CW*dpr;
    uvCanvas.height = CH*dpr;
    uvCanvas.style.height = CH + 'px';
    uvCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // dieline inches -> canvas px
  const toPx = (x, y) => [view.ox + x*view.s, view.oy + y*view.s];

  function artCorners(){
    const ih = draft.iw / (draft.img.naturalWidth / draft.img.naturalHeight);
    const hw = draft.iw/2, hh = ih/2;
    const co = Math.cos(draft.rot), si = Math.sin(draft.rot);
    // local corner -> dieline -> canvas
    return [[-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh]].map(([lx,ly])=>{
      const dx = draft.cx + lx*co - ly*si;
      const dy = draft.cy + lx*si + ly*co;
      return toPx(dx, dy);
    });
  }
  function rotHandlePx(){
    const ih = draft.iw / (draft.img.naturalWidth / draft.img.naturalHeight);
    const ly = -ih/2 - ROT_STEM/view.s;
    const co = Math.cos(draft.rot), si = Math.sin(draft.rot);
    return toPx(draft.cx - ly*si, draft.cy + ly*co);
  }

  function drawUv(){
    const L = dielineLayout(state.bw, state.bh, state.bd);
    view.s = Math.min((CW - PAD*2)/L.W, (CH - PAD*2)/L.H);
    view.ox = (CW - L.W*view.s)/2;
    view.oy = (CH - L.H*view.s)/2;

    uvCtx.clearRect(0, 0, CW, CH);
    uvCtx.fillStyle = '#0b0c0f';
    uvCtx.fillRect(0, 0, CW, CH);

    // ---- artwork, at the draft transform ----
    if(draft.img){
      const ih = draft.iw / (draft.img.naturalWidth / draft.img.naturalHeight);
      uvCtx.save();
      uvCtx.globalAlpha = uvOpacity;
      const [px, py] = toPx(draft.cx, draft.cy);
      uvCtx.translate(px, py);
      uvCtx.rotate(draft.rot);
      uvCtx.drawImage(draft.img,
        -draft.iw*view.s/2, -ih*view.s/2, draft.iw*view.s, ih*view.s);
      uvCtx.restore();
    }

    // ---- dieline, always on top ----
    uvCtx.save();
    uvCtx.lineWidth = 1.5;
    uvCtx.strokeStyle = '#2C86ED';
    uvCtx.fillStyle = 'rgba(44,134,237,.85)';
    uvCtx.font = '600 10px "Geist Mono", monospace';
    uvCtx.textAlign = 'center';
    uvCtx.textBaseline = 'middle';
    const NAMES = {top:'TOP', lside:'L SIDE', front:'FRONT', rside:'R SIDE', back:'BACK', bottom:'BOTTOM'};
    for(const [k, r] of Object.entries(L.faces)){
      const [a] = [toPx(r[0], r[1])], [b] = [toPx(r[2], r[3])];
      uvCtx.strokeRect(a[0], a[1], b[0]-a[0], b[1]-a[1]);
      uvCtx.fillText(NAMES[k], (a[0]+b[0])/2, (a[1]+b[1])/2);
    }
    // outer silhouette, heavier
    uvCtx.lineWidth = 2.5;
    uvCtx.strokeStyle = '#5aa9ff';
    const f = L.faces;
    const path = [
      [f.top[0], f.top[1]], [f.top[2], f.top[1]], [f.top[2], f.lside[1]],
      [f.back[2], f.lside[1]], [f.back[2], f.lside[3]], [f.bottom[2], f.lside[3]],
      [f.bottom[2], f.bottom[3]], [f.bottom[0], f.bottom[3]], [f.bottom[0], f.lside[3]],
      [f.lside[0], f.lside[3]], [f.lside[0], f.lside[1]], [f.top[0], f.lside[1]]
    ];
    uvCtx.beginPath();
    path.forEach(([x,y], i)=>{
      const [px, py] = toPx(x, y);
      i ? uvCtx.lineTo(px, py) : uvCtx.moveTo(px, py);
    });
    uvCtx.closePath();
    uvCtx.stroke();
    uvCtx.restore();

    // ---- gumball ----
    if(draft.img){
      const cs = artCorners();
      uvCtx.save();
      uvCtx.strokeStyle = '#ffffff';
      uvCtx.lineWidth = 1;
      uvCtx.setLineDash([4, 3]);
      uvCtx.beginPath();
      cs.forEach(([x,y], i)=> i ? uvCtx.lineTo(x,y) : uvCtx.moveTo(x,y));
      uvCtx.closePath();
      uvCtx.stroke();
      uvCtx.setLineDash([]);

      // rotation stem + knob
      const rh = rotHandlePx();
      const topMid = [(cs[0][0]+cs[1][0])/2, (cs[0][1]+cs[1][1])/2];
      uvCtx.beginPath();
      uvCtx.moveTo(topMid[0], topMid[1]);
      uvCtx.lineTo(rh[0], rh[1]);
      uvCtx.stroke();
      uvCtx.fillStyle = '#ffffff';
      uvCtx.beginPath();
      uvCtx.arc(rh[0], rh[1], KNOB_R, 0, Math.PI*2);
      uvCtx.fill();

      // corner scale handles
      cs.forEach(([x,y])=>{
        uvCtx.fillStyle = '#ffffff';
        uvCtx.fillRect(x-HANDLE_HALF, y-HANDLE_HALF, HANDLE_HALF*2, HANDLE_HALF*2);
        uvCtx.strokeStyle = '#2C86ED';
        uvCtx.strokeRect(x-HANDLE_HALF, y-HANDLE_HALF, HANDLE_HALF*2, HANDLE_HALF*2);
      });
      uvCtx.restore();
    }
  }

  function localPoint(e){
    const r = uvCanvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (CW / r.width), (e.clientY - r.top) * (CH / r.height)];
  }
  const dist = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1]);

  function insideArt(p, cs){
    // even-odd test against the rotated quad
    let inside = false;
    for(let i = 0, j = 3; i < 4; j = i++){
      const [xi, yi] = cs[i], [xj, yj] = cs[j];
      if((yi > p[1]) !== (yj > p[1]) &&
         p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // Cursor feedback while hovering (not dragging). Corner handles get a diagonal
  // resize cursor chosen from the handle's actual screen angle, so it stays
  // correct as the artwork rotates: a handle pointing up-left/down-right reads
  // nwse, up-right/down-left reads nesw.
  function updateHoverCursor(e){
    if(!draft || !draft.img){ uvCanvas.style.cursor = 'grab'; return; }
    const p = localPoint(e);
    const cs = artCorners();
    const centre = toPx(draft.cx, draft.cy);

    if(dist(p, rotHandlePx()) < ROT_HIT){ uvCanvas.style.cursor = 'grab'; return; }   // rotation knob

    const hit = cs.findIndex(c => dist(p, c) < CORNER_HIT);
    if(hit >= 0){
      const c = cs[hit];
      let deg = Math.atan2(c[1] - centre[1], c[0] - centre[0]) * 180 / Math.PI;   // handle direction
      deg = ((deg % 180) + 180) % 180;                                            // fold to 0..180
      // bands centred on the diagonals so the four corners always read diagonal,
      // with ew/ns only appearing when rotation swings a handle near
      // horizontal/vertical
      uvCanvas.style.cursor =
          (deg < 22.5 || deg >= 157.5) ? 'ew-resize'
        : (deg < 67.5)                 ? 'nwse-resize'
        : (deg < 112.5)                ? 'ns-resize'
        :                                'nesw-resize';
      return;
    }
    uvCanvas.style.cursor = insideArt(p, cs) ? 'move' : 'grab';
  }

  if(uvCanvas){
    uvCanvas.addEventListener('pointerdown', e=>{
      if(!draft || !draft.img) return;
      const p = localPoint(e);
      const cs = artCorners();
      const centre = toPx(draft.cx, draft.cy);

      if(dist(p, rotHandlePx()) < ROT_HIT){
        uvDrag = {mode:'rotate', startAng: Math.atan2(p[1]-centre[1], p[0]-centre[0]), rot0: draft.rot};
      } else {
        const hit = cs.findIndex(c => dist(p, c) < CORNER_HIT);
        if(hit >= 0){
          uvDrag = {mode:'scale', d0: Math.max(1, dist(p, centre)), iw0: draft.iw};
        } else if(insideArt(p, cs)){
          uvDrag = {mode:'move', p0: p, cx0: draft.cx, cy0: draft.cy};
        }
      }
      if(uvDrag){
        uvCanvas.setPointerCapture(e.pointerId);
        uvCanvas.classList.add('dragging');
      }
    });

    uvCanvas.addEventListener('pointermove', e=>{
      if(!uvDrag){
        updateHoverCursor(e);      // not dragging: reflect what's under the pointer
        return;
      }
      const L = dielineLayout(state.bw, state.bh, state.bd);
      const p = localPoint(e);
      const centre = toPx(draft.cx, draft.cy);

      if(uvDrag.mode === 'move'){
        draft.cx = uvDrag.cx0 + (p[0] - uvDrag.p0[0]) / view.s;
        draft.cy = uvDrag.cy0 + (p[1] - uvDrag.p0[1]) / view.s;
      } else if(uvDrag.mode === 'scale'){
        const k = Math.max(1, dist(p, centre)) / uvDrag.d0;
        draft.iw = Math.min(L.W*6, Math.max(L.W*0.05, uvDrag.iw0 * k));
      } else if(uvDrag.mode === 'rotate'){
        const ang = Math.atan2(p[1]-centre[1], p[0]-centre[0]);
        let r = uvDrag.rot0 + (ang - uvDrag.startAng);
        if(e.shiftKey) r = Math.round(r / (Math.PI/12)) * (Math.PI/12);   // 15deg snap
        draft.rot = r;
      }
      drawUv();
    });

    ['pointerup','pointercancel'].forEach(ev=>
      uvCanvas.addEventListener(ev, ()=>{ uvDrag = null; uvCanvas.classList.remove('dragging'); uvCanvas.style.cursor = 'grab'; }));
  }

  function openEditor(){
    if(!state.boxArt.img) return;
    draft = Object.assign({}, state.boxArt);        // shallow copy; img shared, transform not
    if(!draft.iw) fitArtwork(draft, dielineLayout(state.bw, state.bh, state.bd));
    sizeUvCanvas();
    drawUv();
  }
  function closeEditor(){
    draft = null;
    uvDrag = null;
  }

  // ============ public API ============
  function setParams(patch){ Object.assign(state, patch); build(); }

  function getState(){
    return {
      tiers:state.tiers, cols:state.cols, rows:state.rows,
      dh:state.dh, hh:state.hh, bw:state.bw, bh:state.bh, bd:state.bd,
      pad:state.pad, backPad:state.backPad, st:state.st,
      header:state.header, unit:state.unit,
      cStand:state.cStand, cShelf:state.cShelf, cPad:state.cPad,
      focal:state.focal, camY:state.camY, view:state.view,
      showDims:state.showDims, exportSize:state.exportSize
    };
  }

  function setUnit(u){ state.unit = u; if(built) build(); }   // relabels dim callouts

  function setView(v){
    state.view = v;
    activeCam = (v === 'front') ? orthoCam : perspCam;
  }

  function setShowDims(b){ state.showDims = b; dimGroup.visible = b; updateLabelScreen(); }

  function setFocal(v){ state.focal = v; fitCameras(); }

  function setCamHeight(v){ state.camY = v; orbit.target.set(0, bounds.h*(v/100), 0); applyOrbit(); }

  function setCamAngle(v){ orbit.pol = sliderToPol(v); if(state.view === 'iso') applyOrbit(); }

  function resetCamera(){
    setView('iso');
    orbit.az = ORBIT_DEFAULT.az;
    orbit.pol = ORBIT_DEFAULT.pol;
    orbit.target.set(0, bounds.h * (state.camY/100), 0);
    orbit.r = fitRadius();
    applyOrbit();
    emit.viewChange('iso');
    emit.cameraChange(angleSliderValue());
  }

  function setTexture(key, url){
    if(!url){ delete state.tex[key]; build(); return; }
    new THREE.TextureLoader().load(url, tex=>{
      tex.encoding = THREE.sRGBEncoding;
      tex.anisotropy = 8;
      state.tex[key] = tex;
      build();
    });
  }

  // img is a loaded HTMLImageElement (the UI decodes it, since it also needs it
  // for the slot thumbnail) or null to clear.
  function setBoxArt(img){
    if(!img){ state.boxArt = {img:null, cx:0, cy:0, iw:0, rot:0}; build(); return; }
    state.boxArt.img = img;
    fitArtwork(state.boxArt, dielineLayout(state.bw, state.bh, state.bd));
    build();
  }
  function hasBoxArt(){ return !!state.boxArt.img; }

  function renderPNG(size){
    const restore = stageSize();
    const wasVisible = dimGroup.visible;
    dimGroup.visible = false;              // callouts never render into the PNG
    renderer.setSize(size, size, false);
    scene.background = BG;
    renderer.render(scene, activeCam);
    const url = renderer.domElement.toDataURL('image/png');
    renderer.setSize(restore, restore, true);
    dimGroup.visible = wasVisible;
    return url;
  }

  function reset(){
    Object.assign(state, freshState());
    activeCam = perspCam;
    orbit.az = ORBIT_DEFAULT.az;
    orbit.pol = ORBIT_DEFAULT.pol;
    build();
    fitCameras();
  }

  // ---- boot ----
  resize();
  build();
  fitCameras();          // build() sets bounds; reframe once now that they're real
  positionBoxCount();
  built = true;
  loop();

  return {
    // constants the UI needs to build its controls
    UNITS, DIM_BOUNDS, DIM_KEYS, TYPEABLE, SLOTS, MM_PER_IN,

    // geometry / state
    getState, setParams, setUnit,
    setTexture, setBoxArt, hasBoxArt,

    // view + camera
    setView, setShowDims, setFocal, setCamHeight, setCamAngle,
    resetCamera, angleSliderValue,

    // output + lifecycle
    renderPNG, reset, resize,

    // UV editor (the modal shell lives in the page; this drives the canvas)
    uv: {
      open(){ openEditor(); },
      setOpacity(v){ uvOpacity = v/100; drawUv(); },
      fit(){ fitArtwork(draft, dielineLayout(state.bw, state.bh, state.bd)); drawUv(); },
      commit(){ state.boxArt = Object.assign({}, draft); closeEditor(); build(); },
      cancel(){ closeEditor(); }
    }
  };
}

return { init };
})();
