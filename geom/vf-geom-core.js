/**
 * Core geometry: simplicial data packed for GPU.
 * Vertex layout (matches vf-geom-wgpu.js): pos(3) + normal(3) + color(4) = 10 f32 = 40 bytes.
 * Orders: 0=vertex, 1=edge, 2=face(tri), 3=volume(tet).
 * Builders: buildBox, buildSphere, buildPoints, buildEdges, buildTet.
 * Presets: legacy named presets for direct use in demo pages.
 */
(function (global) {
  "use strict";

  // ── Logger (forwards to C++ host log via same channel as vf-log.js) ───────
  function clog(level, text) {
    var s = "[vf-geom-core] " + String(text);
    try {
      if (global.console) {
        if (level === "error" && global.console.error) { global.console.error(s); return; }
        if (global.console.log) { global.console.log(s); }
      }
    } catch (_) {}
    try {
      if (global.chrome && global.chrome.webview && global.chrome.webview.postMessage) {
        global.chrome.webview.postMessage({ type: "vf_log", level: level, message: s, t: Date.now() });
      }
    } catch (_) {}
  }

  var V = 10; // floats per vertex: x,y,z, nx,ny,nz, r,g,b,a
  var N2 = [0, 0, 1]; // default normal (faces viewer in z=0 plane)

  // --- Low-level helpers ---

  function cross3(a, b) {
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  }
  function norm3(v) {
    var l = Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]);
    if (l < 1e-12) { return [0,0,1]; }
    return [v[0]/l, v[1]/l, v[2]/l];
  }
  function add3(a, b) { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
  function scale3(a, s) { return [a[0]*s, a[1]*s, a[2]*s]; }

  function vtx(x, y, z, nx, ny, nz, r, g, b, a) {
    return [x, y, z, nx, ny, nz, r, g, b, a];
  }

  function interleave(verts) {
    var a = new Float32Array(verts.length * V);
    for (var i = 0; i < verts.length; i++) {
      for (var j = 0; j < V; j++) { a[i*V+j] = verts[i][j]; }
    }
    return a;
  }

  // Parse CSS color name / #hex to [r,g,b,a]
  var CSS = {
    white:[1,1,1,1], black:[0,0,0,1], red:[1,0.1,0.1,1],
    green:[0.15,0.85,0.15,1], blue:[0.15,0.35,1,1],
    yellow:[1,0.9,0.1,1], cyan:[0.1,0.9,0.9,1], magenta:[0.9,0.1,0.9,1],
    orange:[1,0.5,0.05,1], gray:[0.5,0.5,0.5,1], grey:[0.5,0.5,0.5,1],
  };
  function parseColor(c) {
    if (!c) { return [0.8,0.8,0.8,1]; }
    if (typeof c === "object" && c.length >= 3) {
      return [c[0],c[1],c[2], c.length>=4?c[3]:1];
    }
    var s = String(c).toLowerCase().trim();
    if (CSS[s]) { return CSS[s].slice(); }
    if (s[0] === "#") {
      var h = s.slice(1);
      if (h.length === 3) { h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2]; }
      var n = parseInt(h, 16);
      return [((n>>16)&255)/255, ((n>>8)&255)/255, (n&255)/255, 1];
    }
    return [0.8,0.8,0.8,1];
  }

  // =========================================================================
  // ORDER-2: Triangle (face) primitives
  // =========================================================================

  function preset2dTriangle() {
    var col0=parseColor("red"), col1=parseColor("cyan"), col2=parseColor("green");
    return {
      id:"2d_tri", mode3d:false, label:"2D: triangle",
      vertices: interleave([
        vtx( 0,   0.75,0, N2[0],N2[1],N2[2], col0[0],col0[1],col0[2],1),
        vtx(-0.7,-0.45,0, N2[0],N2[1],N2[2], col1[0],col1[1],col1[2],1),
        vtx( 0.7,-0.45,0, N2[0],N2[1],N2[2], col2[0],col2[1],col2[2],1),
      ]),
      indices: new Uint32Array([0,1,2]),
      topology:"triangle-list",
    };
  }

  function preset2dQuad() {
    var c = parseColor("orange");
    return {
      id:"2d_quad", mode3d:false, label:"2D: quad",
      vertices: interleave([
        vtx(-0.6, 0.6,0, N2[0],N2[1],N2[2], 0.85,0.45,0.15,1),
        vtx( 0.6, 0.6,0, N2[0],N2[1],N2[2], 0.15,0.5, 0.95,1),
        vtx( 0.6,-0.6,0, N2[0],N2[1],N2[2], 0.35,0.9, 0.45,1),
        vtx(-0.6,-0.6,0, N2[0],N2[1],N2[2], 0.75,0.35,0.85,1),
      ]),
      indices: new Uint32Array([0,1,2, 0,2,3]),
      topology:"triangle-list",
    };
  }

  function preset2dRect() { var p=preset2dQuad(); p.id="2d_rect"; p.label="2D: rectangle"; return p; }

  function preset2dPolygon() {
    var n=8, R=0.7;
    var verts = [vtx(0,0,0, N2[0],N2[1],N2[2], 0.2,0.22,0.3,1)];
    for (var k=0;k<n;k++) {
      var a=(k*2*Math.PI)/n - Math.PI/2, t=k/n;
      verts.push(vtx(R*Math.cos(a),R*Math.sin(a),0, N2[0],N2[1],N2[2],
        0.35+0.5*t, 0.4+0.45*Math.sin(2*a), 0.85-0.4*t, 1));
    }
    var idx=[];
    for (var t=0;t<n;t++) { idx.push(0, 1+t, 1+((t+1)%n)); }
    return { id:"2d_poly", mode3d:false, label:"2D: polygon (octagon)",
             vertices:interleave(verts), indices:new Uint32Array(idx), topology:"triangle-list" };
  }

  function preset2dHex() {
    var R=0.65;
    var cols=[[0.95,0.4,0.35],[0.4,0.85,0.4],[0.4,0.55,0.95],
              [0.85,0.75,0.3],[0.6,0.35,0.9],[0.3,0.85,0.85]];
    var verts=[vtx(0,0,0, N2[0],N2[1],N2[2], 0.5,0.55,0.6,1)];
    for (var k=0;k<6;k++) {
      var a=(k*Math.PI)/3 - Math.PI/2, c=cols[k];
      verts.push(vtx(R*Math.cos(a),R*Math.sin(a),0, N2[0],N2[1],N2[2], c[0],c[1],c[2],1));
    }
    var idx=[]; for (var t=0;t<6;t++) { idx.push(0,1+t,1+((t+1)%6)); }
    return { id:"2d_hex", mode3d:false, label:"2D: hex",
             vertices:interleave(verts), indices:new Uint32Array(idx), topology:"triangle-list" };
  }

  // =========================================================================
  // ORDER-3: Cube (solid box)
  // =========================================================================

  var CUBE8 = [
    [-0.5,-0.5,-0.5],[0.5,-0.5,-0.5],[0.5,0.5,-0.5],[-0.5,0.5,-0.5],
    [-0.5,-0.5, 0.5],[0.5,-0.5, 0.5],[0.5,0.5, 0.5],[-0.5,0.5, 0.5],
  ];
  var CUBE_FACES = [
    { verts:[0,1,2,3], n:[0,0,-1] }, { verts:[4,5,6,7], n:[0,0,1] },
    { verts:[0,1,5,4], n:[0,-1,0] }, { verts:[2,3,7,6], n:[0,1,0] },
    { verts:[0,3,7,4], n:[-1,0,0] }, { verts:[1,2,6,5], n:[1,0,0] },
  ];
  var FACE_COLS = [
    [0.85,0.2,0.25],[0.25,0.75,0.35],[0.25,0.4,0.9],
    [0.9,0.75,0.2], [0.7,0.35,0.85],[0.35,0.85,0.9],
  ];

  /**
   * Build a box mesh.
   * @param {number[]} center  [cx,cy,cz]
   * @param {number[]} scale   [sx,sy,sz]  (half-extents × 2; scale=[1,1,1] → unit cube)
   * @param {string|number[]} color  CSS name / #hex / [r,g,b] — applies to all faces uniformly
   * @param {string} [id]
   */
  function buildBox(center, scale, color, id) {
    clog("info", "buildBox id=" + id + " center=" + JSON.stringify(center) + " scale=" + JSON.stringify(scale));
    center = center || [0,0,0];
    scale  = scale  || [1,1,1];
    var col = color ? parseColor(color) : null;
    var verts=[], idx=[];
    for (var fi=0;fi<6;fi++) {
      var f   = CUBE_FACES[fi];
      var c   = col || FACE_COLS[fi].concat([1]);
      var n   = f.n;
      var base= verts.length;
      for (var j=0;j<4;j++) {
        var p = CUBE8[f.verts[j]];
        verts.push(vtx(
          center[0] + p[0]*scale[0],
          center[1] + p[1]*scale[1],
          center[2] + p[2]*scale[2],
          n[0], n[1], n[2],
          c[0], c[1], c[2], c.length>=4?c[3]:1
        ));
      }
      idx.push(base, base+1, base+2, base, base+2, base+3);
    }
    return {
      id: id || "box",
      mode3d: true,
      label: "box",
      vertices: interleave(verts),
      indices: new Uint32Array(idx),
      topology: "triangle-list",
    };
  }

  function preset3dCubeSolid() { return buildBox([0,0,0],[1,1,1],null,"3d_cube"); }

  /**
   * Build a UV sphere mesh.
   * @param {number[]} center [cx,cy,cz]
   * @param {number} radius
   * @param {string|number[]} color
   * @param {string} [id]
   */
  function buildSphere(center, radius, color, id) {
    center = center || [0, 0, 0];
    radius = (typeof radius === "number" && radius > 0) ? radius : 0.5;
    var c = color ? parseColor(color) : [0.86, 0.58, 0.18, 1];
    var latSeg = 24, lonSeg = 32;
    var verts = [], idx = [];
    for (var j = 0; j <= latSeg; j++) {
      var v = j / latSeg;
      var phi = v * Math.PI;
      var sp = Math.sin(phi), cp = Math.cos(phi);
      for (var i = 0; i <= lonSeg; i++) {
        var u = i / lonSeg;
        var th = u * Math.PI * 2;
        var st = Math.sin(th), ct = Math.cos(th);
        var nx = sp * ct;
        var ny = cp;
        var nz = sp * st;
        verts.push(vtx(
          center[0] + radius * nx,
          center[1] + radius * ny,
          center[2] + radius * nz,
          nx, ny, nz,
          c[0], c[1], c[2], c.length >= 4 ? c[3] : 1
        ));
      }
    }
    var row = lonSeg + 1;
    for (var y = 0; y < latSeg; y++) {
      for (var x = 0; x < lonSeg; x++) {
        var a = y * row + x;
        var b = a + 1;
        var c0 = a + row;
        var d = c0 + 1;
        idx.push(a, c0, b, b, c0, d);
      }
    }
    return {
      id: id || "sphere",
      mode3d: true,
      label: "sphere",
      vertices: interleave(verts),
      indices: new Uint32Array(idx),
      topology: "triangle-list",
    };
  }

  /**
   * Build a torus mesh.
   * @param {number[]} center [cx,cy,cz]
   * @param {number} majorRadius
   * @param {number} minorRadius
   * @param {string|number[]} color
   * @param {string} [id]
   */
  function buildTorus(center, majorRadius, minorRadius, color, id) {
    center = center || [0, 0, 0];
    majorRadius = (typeof majorRadius === "number" && majorRadius > 0) ? majorRadius : 0.65;
    minorRadius = (typeof minorRadius === "number" && minorRadius > 0) ? minorRadius : 0.22;
    var c = color ? parseColor(color) : [0.90, 0.50, 0.18, 1];
    var majorSeg = 48, minorSeg = 24;
    var verts = [], idx = [];
    for (var j = 0; j <= majorSeg; j++) {
      var u = j / majorSeg;
      var a = u * Math.PI * 2;
      var ca = Math.cos(a), sa = Math.sin(a);
      for (var i = 0; i <= minorSeg; i++) {
        var v = i / minorSeg;
        var b = v * Math.PI * 2;
        var cb = Math.cos(b), sb = Math.sin(b);
        var ring = majorRadius + minorRadius * cb;
        var x = ring * ca;
        var y = minorRadius * sb;
        var z = ring * sa;
        var nx = cb * ca;
        var ny = sb;
        var nz = cb * sa;
        verts.push(vtx(
          center[0] + x,
          center[1] + y,
          center[2] + z,
          nx, ny, nz,
          c[0], c[1], c[2], c.length >= 4 ? c[3] : 1
        ));
      }
    }
    var row = minorSeg + 1;
    for (var y = 0; y < majorSeg; y++) {
      for (var x = 0; x < minorSeg; x++) {
        var a0 = y * row + x;
        var b0 = a0 + 1;
        var c0 = a0 + row;
        var d0 = c0 + 1;
        idx.push(a0, c0, b0, b0, c0, d0);
      }
    }
    return {
      id: id || "torus",
      mode3d: true,
      label: "torus",
      vertices: interleave(verts),
      indices: new Uint32Array(idx),
      topology: "triangle-list",
    };
  }

  // wireframe cube (order-1: edges)
  var CUBE_EDGES = [
    [0,1],[1,2],[2,3],[3,0], [4,5],[5,6],[6,7],[7,4],
    [0,4],[1,5],[2,6],[3,7],
  ];
  function preset3dCubeWire() {
    var verts=[];
    for (var i=0;i<8;i++) {
      var p=CUBE8[i];
      verts.push(vtx(p[0],p[1],p[2], 0,0,1, 0.2,0.85,0.45,1));
    }
    var idx=[];
    for (var e=0;e<CUBE_EDGES.length;e++) { idx.push(CUBE_EDGES[e][0], CUBE_EDGES[e][1]); }
    return { id:"3d_cube_wire", mode3d:true, label:"3D: cube (wireframe)",
             vertices:interleave(verts), indices:new Uint32Array(idx), topology:"line-list" };
  }

  // =========================================================================
  // ORDER-3: Tetrahedron (4 order-2 faces)
  // =========================================================================
  function preset3dTet() {
    var P = [[0,0.9,0],[-0.75,-0.55,-0.45],[0.75,-0.55,-0.45],[0,-0.2,0.75]];
    var vc= [[0.95,0.35,0.2,1],[0.35,0.85,0.4,1],[0.4,0.45,0.95,1],[0.7,0.7,0.3,1]];
    var faces=[[0,1,2],[0,1,3],[0,2,3],[1,2,3]];
    var accN=[[0,0,0],[0,0,0],[0,0,0],[0,0,0]];
    for (var ff=0;ff<4;ff++) {
      var F=faces[ff], a0=P[F[0]],b0=P[F[1]],c0=P[F[2]];
      var e0=[b0[0]-a0[0],b0[1]-a0[1],b0[2]-a0[2]];
      var e1=[c0[0]-a0[0],c0[1]-a0[1],c0[2]-a0[2]];
      var fn0=cross3(e0,e1);
      for (var t=0;t<3;t++) {
        var vi=F[t];
        accN[vi]=[accN[vi][0]+fn0[0],accN[vi][1]+fn0[1],accN[vi][2]+fn0[2]];
      }
    }
    var norms=[norm3(accN[0]),norm3(accN[1]),norm3(accN[2]),norm3(accN[3])];
    var verts=[];
    for (var v=0;v<4;v++) {
      var q=P[v], c=vc[v], nn=norms[v];
      verts.push(vtx(q[0],q[1],q[2], nn[0],nn[1],nn[2], c[0],c[1],c[2],c[3]));
    }
    var idx=[];
    for (var f=0;f<4;f++) { var F=faces[f]; idx.push(F[0],F[1],F[2]); }
    return { id:"3d_tet", mode3d:true, label:"3D: tetrahedron",
             vertices:interleave(verts), indices:new Uint32Array(idx), topology:"triangle-list" };
  }

  // =========================================================================
  // ORDER-2: Surface (heightfield)
  // =========================================================================
  function preset3dSurface() {
    var nx=28, ny=28, x0=-0.75, x1=0.75, y0=-0.75, y1=0.75;
    function zfun(x,y){ return 0.3*Math.sin(2.2*x*Math.PI)*Math.cos(1.8*y*Math.PI)*(0.6+0.4*(1-x*x-y*y)); }
    var verts=[];
    for (var j=0;j<=ny;j++) {
      for (var i=0;i<=nx;i++) {
        var u=i/nx, v=j/ny;
        var x=x0+(x1-x0)*u, y=y0+(y1-y0)*v, z=zfun(x,y);
        var bright=0.5+0.5*(z/0.32);
        bright=Math.max(0,Math.min(1,bright));
        // approximate normals via finite diff
        var eps=0.01;
        var ex=[1,0,zfun(x+eps,y)-z]; var ey=[0,1,zfun(x,y+eps)-z];
        var nn=norm3(cross3(ey,ex)); // CCW
        verts.push(vtx(x,y,z, nn[0],nn[1],nn[2], 0.15+0.5*bright, 0.35+0.28*(1-bright), 0.8+0.15*bright, 1));
      }
    }
    function vid(i,j){ return j*(nx+1)+i; }
    var idx=[];
    for (var jj=0;jj<ny;jj++) {
      for (var ii=0;ii<nx;ii++) {
        var a=vid(ii,jj), b=vid(ii+1,jj), c=vid(ii,jj+1), d=vid(ii+1,jj+1);
        idx.push(a,c,b, b,c,d);
      }
    }
    return { id:"3d_surface", mode3d:true, label:"3D: surface (heightfield)",
             vertices:interleave(verts), indices:new Uint32Array(idx), topology:"triangle-list" };
  }

  // =========================================================================
  // ORDER-0: Point cloud (rendered as tiny degenerate tris or line-list)
  // =========================================================================
  /**
   * Build a point cloud (order-0).  Rendered as line-list (1-pixel endpoints).
   * @param {number[][]} points  array of [x,y,z]
   * @param {string|number[]} color
   */
  function buildPoints(points, color) {
    var c = parseColor(color || "white");
    var verts=[], idx=[];
    for (var i=0;i<points.length;i++) {
      var p=points[i];
      verts.push(vtx(p[0],p[1],p[2], 0,0,1, c[0],c[1],c[2],1));
      idx.push(i,i); // degenerate line = point
    }
    return { id:"points", mode3d:true, label:"order-0: points",
             vertices:interleave(verts), indices:new Uint32Array(idx), topology:"line-list" };
  }

  // =========================================================================
  // ORDER-1: Edge list
  // =========================================================================
  /**
   * Build an edge list (order-1).
   * @param {number[][]} verts  array of [x,y,z]
   * @param {number[][]} edges  array of [i,j] index pairs
   * @param {string|number[]} color
   */
  function buildEdges(vList, eList, color) {
    var c = parseColor(color || "cyan");
    var verts = vList.map(function(p){
      return vtx(p[0],p[1],p[2], 0,0,1, c[0],c[1],c[2],1);
    });
    var idx=[];
    for (var e=0;e<eList.length;e++) { idx.push(eList[e][0], eList[e][1]); }
    return { id:"edges", mode3d:true, label:"order-1: edges",
             vertices:interleave(verts), indices:new Uint32Array(idx), topology:"line-list" };
  }

  // =========================================================================
  // Merge multiple meshes into one (all triangle-list or all line-list)
  // =========================================================================
  function mergeMeshes(meshes, id) {
    if (!meshes || !meshes.length) { return null; }
    var allVerts=[], allIdx=[], offset=0;
    var topo = meshes[0].topology || "triangle-list";
    for (var m=0;m<meshes.length;m++) {
      var mesh=meshes[m];
      var vf = mesh.vertices;
      var nv = vf.length / V;
      for (var i=0;i<vf.length;i++) { allVerts.push(vf[i]); }
      var ids=mesh.indices;
      for (var j=0;j<ids.length;j++) { allIdx.push(ids[j]+offset); }
      offset += nv;
    }
    var vbuf = new Float32Array(allVerts);
    return {
      id: id || "merged",
      mode3d: meshes[0].mode3d,
      label: "merged",
      vertices: vbuf,
      indices: new Uint32Array(allIdx),
      topology: topo,
      camera: meshes[0].camera,
      lights: meshes[0].lights,
    };
  }

  // =========================================================================
  // Registry
  // =========================================================================
  var PRESETS = {
    "2d_tri":       preset2dTriangle,
    "2d_quad":      preset2dQuad,
    "2d_rect":      preset2dRect,
    "2d_poly":      preset2dPolygon,
    "2d_hex":       preset2dHex,
    "3d_cube":      preset3dCubeSolid,
    "3d_cube_wire": preset3dCubeWire,
    "3d_tet":       preset3dTet,
    "3d_surface":   preset3dSurface,
  };

  function getPreset(name) {
    var fn = PRESETS[name];
    return fn ? fn() : preset2dTriangle();
  }

  clog("info", "VfGeomCore registered");
  global.VfGeomCore = {
    STRIDE:      V,
    BYTES_PER_VERTEX: V * 4,
    getPreset:   getPreset,
    PRESET_IDS:  Object.keys(PRESETS),
    buildBox:    buildBox,
    buildSphere: buildSphere,
    buildTorus:  buildTorus,
    buildPoints: buildPoints,
    buildEdges:  buildEdges,
    mergeMeshes: mergeMeshes,
    parseColor:  parseColor,
    interleave:  interleave,
    vertex:      vtx,
  };
})(typeof window !== "undefined" ? window : this);
