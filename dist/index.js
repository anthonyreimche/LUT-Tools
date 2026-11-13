//#region src/encoding.ts
var e = [
	{
		id: 0,
		label: "sRGB"
	},
	{
		id: 1,
		label: "Rec.709 (gamma 2.4)"
	},
	{
		id: 2,
		label: "Gamma 2.2"
	},
	{
		id: 3,
		label: "Linear"
	}
];
function t(t) {
	return e.some((e) => e.id === t);
}
//#endregion
//#region src/pack.ts
var n = 4096, r = n * 4096;
function i(e) {
	return parseInt(e.slice(0, 8), 16) & 2147483647 || 1;
}
var a = (e) => Math.floor(e / 2 ** 29) % 4, o = (e) => `p${e}`;
function s(e) {
	let t = new Uint8Array(new Float32Array(e).buffer), n = 2166136261;
	for (let e of t) n = Math.imul(n ^ e, 16777619);
	return n >>> 0;
}
function c(e) {
	return s([
		e.kind,
		e.n3,
		e.n1,
		...e.lo3,
		...e.hi3,
		...e.lo1,
		...e.hi1,
		...e.range3,
		...e.range1
	]) & 2147483647;
}
function l(e) {
	let t = Infinity, n = -Infinity;
	for (let r of e.data) r < t && (t = r), r > n && (n = r);
	return n - t > 1e-9 ? [t, n] : [t, t + 1];
}
var u = (e, t) => Math.min(65535, Math.max(0, Math.round((e - t[0]) / (t[1] - t[0]) * 65535))), d = (e) => e.kind & 1 ? 3 * (e.n1 - 1) : 0, f = (e) => e.kind & 2 ? 2 * e.n3 ** 3 : 0;
function p(e, t) {
	let n = [0, 1], r = {
		kind: +!!e.shaper | (e.cube ? 2 : 0),
		n3: e.cube?.size ?? 2,
		n1: e.shaper?.size ?? 2,
		lo3: e.cube ? [...e.cube.lo] : [
			0,
			0,
			0
		],
		hi3: e.cube ? [...e.cube.hi] : [
			1,
			1,
			1
		],
		lo1: e.shaper ? [...e.shaper.lo] : [
			0,
			0,
			0
		],
		hi1: e.shaper ? [...e.shaper.hi] : [
			1,
			1,
			1
		],
		range3: e.cube ? l(e.cube) : n,
		range1: e.shaper ? l(e.shaper) : n
	}, i = new Uint8Array(4 * (d(r) + f(r))), a = 0;
	if (e.shaper) {
		let t = r.n1, n = e.shaper.data;
		for (let e = 0; e < 3; e++) for (let o = 0; o < t - 1; o++) {
			let t = u(n[3 * o + e], r.range1), s = u(n[3 * (o + 1) + e], r.range1);
			i[a] = t >> 8, i[a + 1] = t & 255, i[a + 2] = s >> 8, i[a + 3] = s & 255, a += 4;
		}
	}
	if (e.cube) {
		let t = e.cube.data;
		for (let e = 0; e < t.length; e += 3) {
			for (let n = 0; n < 3; n++) {
				let o = u(t[e + n], r.range3);
				i[a + n] = o >> 8, i[a + 4 + n] = o & 255;
			}
			a += 8;
		}
	}
	return {
		key: t,
		layout: r,
		sig: c(r),
		texels: i
	};
}
function m(e) {
	for (let t = Math.max(8, 2 ** Math.ceil(Math.log2(Math.max(1, 2 * e.length))));; t *= 2) {
		let n = new Uint8Array(t), r = !0;
		for (let i of [...e].sort((e, t) => e - t)) {
			let e = 0;
			for (; e < 4 && n[i + e & t - 1];) e++;
			if (e === 4) {
				r = !1;
				break;
			}
			n[i + e & t - 1] = 1;
		}
		if (r) return t;
	}
}
function h(e) {
	return 1 + 3 * m(e.map((e) => e.key)) + e.reduce((e, t) => e + t.texels.length / 4, 0);
}
function g(e) {
	let t = e.map((e) => e.key);
	if (new Set(t).size !== t.length) throw Error("two LUTs with one key");
	let r = m(t), i = h(e);
	if (i > 16777216) throw Error("the LUTs don't fit in one atlas");
	let a = Math.max(1, Math.ceil(i / n)), o = new Uint8Array(n * a * 4), s = new DataView(o.buffer), c = (e, t) => s.setUint32(4 * e, t >>> 0, !0);
	c(0, r);
	let l = /* @__PURE__ */ new Map(), u = 1 + 3 * r, d = [...e].sort((e, t) => e.key - t.key);
	for (let e of d) {
		let t = e.key & r - 1;
		for (; s.getUint32(4 * (1 + 3 * t), !0) !== 0;) t = t + 1 & r - 1;
		c(1 + 3 * t, e.key), c(2 + 3 * t, u), c(3 + 3 * t, e.sig), o.set(e.texels, 4 * u), l.set(e.key, u), u += e.texels.length / 4;
	}
	return {
		width: n,
		height: a,
		data: o,
		offsets: l,
		slots: r
	};
}
//#endregion
//#region src/library.ts
var _ = new Intl.Collator(void 0, {
	numeric: !0,
	sensitivity: "base"
});
function v(e) {
	return [...e].sort((e, t) => _.compare(e.folder, t.folder) || _.compare(e.name, t.name));
}
function y(e) {
	return e.split(/[\\/]/).slice(0, -1).join("/");
}
var b = (e) => ({
	key: e.key,
	sig: e.sig,
	layout: e.layout,
	texels: e.texels
}), x = "The LUT library is full. Remove LUTs you no longer use from the library, then add this file again.", S = class {
	keys = [];
	blockTexels = 0;
	take(e, t) {
		this.keys.push(e), this.blockTexels += t;
	}
	texelsWith(e, t = 0) {
		let n = e === void 0 ? this.keys : [...this.keys, e];
		return n.length === 0 ? 0 : 1 + 3 * m(n) + this.blockTexels + t;
	}
};
function C(e) {
	let t = Array.from({ length: 4 }, () => new S());
	for (let n of e) t[a(n.key)].take(n.key, n.texels.length / 4);
	return t;
}
function w(e) {
	let t = /* @__PURE__ */ new Map(), n = [], i = 0, o = 0, s = Array.from({ length: 4 }, () => ({
		ids: "",
		version: 0
	})), c = /* @__PURE__ */ new Set();
	function l() {
		i++;
		for (let e of c) e();
	}
	function u() {
		n = v(t.values());
		let i = Array.from({ length: 4 }, () => []);
		for (let e of n) i[a(e.key)].push(e);
		let c = C(n);
		o = Math.max(...c.map((e) => e.texelsWith() / r)), i.forEach((t, n) => {
			let r = t.map((e) => e.id).sort().join(","), i = s[n];
			if (r === i.ids) return;
			if (i.ids = r, t.length === 0) {
				e.setPage(n, null);
				return;
			}
			let a = g(t.map(b));
			e.setPage(n, {
				data: a.data,
				width: a.width,
				height: a.height,
				format: "rgba8",
				version: ++i.version
			});
		}), l();
	}
	async function d() {
		let n = await e.store.all();
		t = new Map(n.map((e) => [e.id, e])), u();
	}
	let f = e.channel?.listen(() => void d());
	function p() {
		u(), e.channel?.post();
	}
	return {
		entries: () => n,
		get: (e) => t.get(e),
		byKey: (e) => n.find((t) => t.key === e),
		async add(n, r) {
			let i = {
				added: [],
				refused: [],
				notes: []
			}, o = new Map([...t.values()].map((e) => [e.key, e])), s = C(t.values());
			for (let [c, l] of n.entries()) {
				r?.(c, n.length);
				let u = l.path.split(/[\\/]/).pop() ?? l.path, d;
				try {
					d = await l.bytes();
				} catch {
					i.refused.push({
						name: u,
						reason: "The file can't be read."
					});
					continue;
				}
				let f = await e.prepare(u, d);
				if (!f.ok) {
					i.refused.push({
						name: u,
						reason: f.error
					});
					continue;
				}
				let p = t.get(f.hash) ?? i.added.find((e) => e.id === f.hash);
				if (p) {
					i.refused.push({
						name: u,
						reason: `It is already in the library as ${p.name}.`
					});
					continue;
				}
				let m = o.get(f.key);
				if (m) {
					i.refused.push({
						name: u,
						reason: `Its key matches ${m.name}'s; this file can't be told apart from it.`
					});
					continue;
				}
				let h = s[a(f.key)];
				if (h.texelsWith(f.key, f.texels.length / 4) > 16777216) {
					i.refused.push({
						name: u,
						reason: x
					});
					continue;
				}
				let g = {
					id: f.hash,
					key: f.key,
					sig: f.sig,
					name: f.title,
					folder: y(l.path),
					format: f.format,
					layout: f.layout,
					texels: f.texels,
					inEnc: 0,
					outEnc: 0,
					addedAt: Date.now()
				};
				await e.store.put(g), o.set(g.key, g), h.take(g.key, g.texels.length / 4), i.added.push(g);
				for (let e of f.notes) i.notes.push({
					name: u,
					note: e
				});
			}
			if (r?.(n.length, n.length), i.added.length > 0) {
				for (let e of i.added) t.set(e.id, e);
				p();
			}
			return i;
		},
		async rename(n, r) {
			let i = t.get(n), a = r.trim();
			if (!i || a === "" || a === i.name) return;
			let o = {
				...i,
				name: a
			};
			await e.store.put(o), t.set(n, o), p();
		},
		async remove(n) {
			let r = n.filter((e) => t.has(e));
			if (r.length !== 0) {
				for (let n of r) await e.store.delete(n), t.delete(n);
				p();
			}
		},
		async setEncodings(r, i, a) {
			let o = t.get(r);
			if (!o || o.inEnc === i && o.outEnc === a) return;
			let s = {
				...o,
				inEnc: i,
				outEnc: a
			};
			await e.store.put(s), t.set(r, s), n = v(t.values()), l(), e.channel?.post();
		},
		usage: () => o,
		revision: () => i,
		subscribe(e) {
			return c.add(e), () => void c.delete(e);
		},
		reload: d,
		dispose() {
			f?.(), c.clear();
		}
	};
}
function T(e) {
	if (typeof BroadcastChannel > "u") return;
	let t = new BroadcastChannel(e);
	return {
		post: () => t.postMessage("changed"),
		listen(e) {
			let n = () => e();
			return t.addEventListener("message", n), () => {
				t.removeEventListener("message", n), t.close();
			};
		}
	};
}
//#endregion
//#region src/lut.ts
var E = 65536, D = (e, t, n) => e < t ? t : e > n ? n : e;
function ee(e) {
	let [t, n, r] = e;
	return t >= n ? n >= r ? [
		0,
		1,
		2
	] : t >= r ? [
		0,
		2,
		1
	] : [
		2,
		0,
		1
	] : r >= n ? [
		2,
		1,
		0
	] : r >= t ? [
		1,
		2,
		0
	] : [
		1,
		0,
		2
	];
}
function O(e, t, n, r = 1) {
	let i = t - 1, a = [
		0,
		0,
		0
	], o = [
		0,
		0,
		0
	], s = [
		0,
		0,
		0
	];
	for (let e = 0; e < 3; e++) {
		s[e] = D(n[e], 0, 1);
		let r = s[e] * i;
		a[e] = Math.min(Math.floor(r), t - 2), o[e] = r - a[e];
	}
	let c = ee(o), l = [
		a[0],
		a[1],
		a[2]
	], u = (e) => 3 * (e[0] + t * (e[1] + t * e[2])), d = u(l), f = [
		e[d],
		e[d + 1],
		e[d + 2]
	], p = Array(9).fill(0);
	for (let t of c) {
		l[t] += 1;
		let n = u(l);
		for (let r = 0; r < 3; r++) {
			let a = e[n + r] - e[d + r];
			f[r] += o[t] * a, p[3 * t + r] = a * i;
		}
		d = n;
	}
	for (let e = 0; e < 3; e++) {
		let t = n[e] - s[e];
		if (t !== 0) for (let n = 0; n < 3; n++) f[n] += p[3 * e + n] * t;
	}
	if (r !== 1) {
		for (let e = 0; e < 3; e++) f[e] /= r;
		for (let e = 0; e < 9; e++) p[e] /= r;
	}
	return {
		value: f,
		jac: p
	};
}
function te(e, t) {
	let n = [
		0,
		0,
		0
	];
	for (let r = 0; r < 3; r++) n[r] = (t[r] - e.lo[r]) / (e.hi[r] - e.lo[r]);
	return O(e.data, e.size, n).value;
}
function ne(e, t, n = [
	0,
	0,
	0
], r = [
	1,
	1,
	1
]) {
	let i = new Float64Array(e * e * e * 3), a = (t, i) => n[t] + (r[t] - n[t]) * i / (e - 1), o = 0;
	for (let n = 0; n < e; n++) for (let r = 0; r < e; r++) for (let s = 0; s < e; s++) {
		let e = t(a(0, s), a(1, r), a(2, n));
		i[o++] = e[0], i[o++] = e[1], i[o++] = e[2];
	}
	return {
		size: e,
		lo: [...n],
		hi: [...r],
		data: i
	};
}
function re(e, t) {
	return e.size === t ? e : ne(t, (t, n, r) => te(e, [
		t,
		n,
		r
	]), e.lo, e.hi);
}
//#endregion
//#region src/cube.ts
var ie = 256, k = (e) => ({
	ok: !1,
	error: e
});
function ae(e, t, n) {
	if (e.length !== 3) return `${n} on line ${t} needs three numbers`;
	let r = e.map(Number);
	return r.every(Number.isFinite) ? [
		r[0],
		r[1],
		r[2]
	] : `${n} on line ${t} isn't three numbers`;
}
function oe(e, t, n) {
	if (e.length !== 2) return `${n} on line ${t} needs two numbers`;
	let r = e.map(Number);
	return r.every(Number.isFinite) ? r[0] < r[1] ? [r[0], r[1]] : `${n} on line ${t} must run from a lower to a higher value` : `${n} on line ${t} isn't two numbers`;
}
function se(e, t, n, r) {
	let i = e.length === 1 ? Number(e[0]) : NaN;
	return !Number.isInteger(i) || i < 2 || i > r ? `${n} on line ${t} must be a whole number from 2 to ${r}` : i;
}
function A(e, t) {
	let n = e.length, r = 0, i = 0;
	for (let a = 0; a < n; a++) r += e[a], i += t[a];
	r /= n, i /= n;
	let a = 0, o = 0, s = 0;
	for (let c = 0; c < n; c++) {
		let n = e[c] - r, l = t[c] - i;
		a += n * l, o += n * n, s += l * l;
	}
	return o > 0 && s > 0 ? a / Math.sqrt(o * s) : 0;
}
function ce(e, t) {
	if (t < 3) return !1;
	let n = t * t * t, r = new Float64Array(n), i = new Float64Array(n), a = new Float64Array(n), o = new Float64Array(n);
	for (let s = 0; s < n; s++) r[s] = s % t, i[s] = Math.floor(s / (t * t)), a[s] = e[3 * s], o[s] = e[3 * s + 2];
	let s = A(a, r) + A(o, i);
	return A(a, i) + A(o, r) > s + .5;
}
function le(e, t) {
	let n = new Float64Array(e.length);
	for (let r = 0; r < t; r++) for (let i = 0; i < t; i++) for (let a = 0; a < t; a++) {
		let o = 3 * (r + t * (i + t * a)), s = 3 * (a + t * (i + t * r));
		n[s] = e[o], n[s + 1] = e[o + 1], n[s + 2] = e[o + 2];
	}
	return n;
}
function ue(e, t) {
	let n = null, r = null, i = null, a = null, o = null, s = null, c = null, l = /* @__PURE__ */ new Set(), u = /* @__PURE__ */ new Float64Array(), d = 0, f = !1, p = e.replace(/^﻿/, "").split(/\r\n|\r|\n/);
	for (let e = 0; e < p.length; e++) {
		let t = e + 1, m = p[e].trim();
		if (m.startsWith("TITLE")) {
			if (f) return k(`TITLE on line ${t} comes after the table data`);
			if (l.has("TITLE")) return k(`TITLE is given twice (line ${t})`);
			l.add("TITLE");
			let e = m.slice(5).trim(), r = /^"([^"]*)"/.exec(e);
			n = (r ? r[1] : e.split("#")[0]).trim();
			continue;
		}
		let h = m.indexOf("#");
		if (h >= 0 && (m = m.slice(0, h).trim()), m === "") continue;
		let g = m.split(/\s+/), _ = g[0];
		if (/^[-+.\d]/.test(_)) {
			if (!f) {
				if (f = !0, r === null && i === null) return k(`Table data starts on line ${t} before LUT_1D_SIZE or LUT_3D_SIZE`);
				u = new Float64Array(3 * ((r ?? 0) + (i ?? 0) ** 3));
			}
			let e = ae(g, t, "The table entry");
			if (typeof e == "string") return k(e);
			if (d + 3 > u.length) return k(`The table has more entries than its size calls for (line ${t})`);
			u[d++] = e[0], u[d++] = e[1], u[d++] = e[2];
			continue;
		}
		if (!/^[A-Z][A-Z0-9_]*$/.test(_)) return k(`Line ${t} isn't a keyword or a table entry: "${m.slice(0, 40)}"`);
		if (f) return k(`${_} on line ${t} comes after the table data`);
		if (l.has(_)) return k(`${_} is given twice (line ${t})`);
		l.add(_);
		let v = g.slice(1);
		switch (_) {
			case "LUT_1D_SIZE": {
				let e = se(v, t, _, E);
				if (typeof e == "string") return k(e);
				r = e;
				break;
			}
			case "LUT_3D_SIZE": {
				let e = se(v, t, _, ie);
				if (typeof e == "string") return k(e);
				i = e;
				break;
			}
			case "DOMAIN_MIN":
			case "DOMAIN_MAX": {
				let e = ae(v, t, _);
				if (typeof e == "string") return k(e);
				_ === "DOMAIN_MIN" ? a = e : o = e;
				break;
			}
			case "LUT_1D_INPUT_RANGE":
			case "LUT_3D_INPUT_RANGE": {
				let e = oe(v, t, _);
				if (typeof e == "string") return k(e);
				_ === "LUT_1D_INPUT_RANGE" ? s = e : c = e;
				break;
			}
			case "LUT_IN_VIDEO_RANGE":
			case "LUT_OUT_VIDEO_RANGE": return k(`${_} (line ${t}): video-range LUTs aren't supported`);
		}
	}
	if (r === null && i === null) return k("The file names no LUT_1D_SIZE or LUT_3D_SIZE");
	if (s && r === null) return k("LUT_1D_INPUT_RANGE is given without a 1D table");
	if (c && i === null) return k("LUT_3D_INPUT_RANGE is given without a 3D table");
	let m = a ?? [
		0,
		0,
		0
	], h = o ?? [
		1,
		1,
		1
	];
	for (let e = 0; e < 3; e++) if (!(m[e] < h[e])) return k("DOMAIN_MIN must be below DOMAIN_MAX in every channel");
	let g = (r ?? 0) + (i ?? 0) ** 3, _ = d / 3;
	if (_ !== g) return k(`The table has ${_} entries where its size${r && i ? "s call" : " calls"} for ${g}`);
	let v = (e, t, n, r) => ({
		size: e,
		lo: r ? [
			r[0],
			r[0],
			r[0]
		] : [...m],
		hi: r ? [
			r[1],
			r[1],
			r[1]
		] : [...h],
		data: u.slice(3 * t, 3 * (t + n))
	}), y = r === null ? null : v(r, 0, r, s), b = i === null ? null : v(i, r ?? 0, i ** 3, c), x = "red-fastest";
	return b && ce(b.data, b.size) && (b = {
		...b,
		data: le(b.data, b.size)
	}, x = "blue-fastest"), {
		ok: !0,
		lut: {
			title: n || t,
			shaper: y,
			cube: b
		},
		axisOrder: x
	};
}
var j = (e) => {
	let t = (Math.abs(e) < 5e-7 ? 0 : e).toFixed(6);
	return t === "-0.000000" ? "0.000000" : t;
};
function de(e, t = []) {
	if (e.shaper && e.cube) throw Error("writeCube writes one table");
	let n = e.cube ?? e.shaper;
	if (!n) throw Error("a LUT without a table");
	let r = t.map((e) => `# ${e}`);
	r.push(`TITLE "${e.title.replace(/"/g, "'")}"`), r.push(e.cube ? `LUT_3D_SIZE ${n.size}` : `LUT_1D_SIZE ${n.size}`), r.push(`DOMAIN_MIN ${n.lo.map(j).join(" ")}`), r.push(`DOMAIN_MAX ${n.hi.map(j).join(" ")}`);
	for (let e = 0; e < n.data.length; e += 3) r.push(`${j(n.data[e])} ${j(n.data[e + 1])} ${j(n.data[e + 2])}`);
	return `${r.join("\n")}\n`;
}
function fe(e, t) {
	if (e !== t) return null;
	for (let t = 2; t <= 16; t++) if (t ** 3 === e) return t;
	return null;
}
var pe = .3;
function me(e, t) {
	let n = e.width * e.height, r = (e, n) => Math.floor(e / t ** n) % t, i = 0;
	for (let t = 0; t < 3; t++) for (let a = 0; a < 3; a++) {
		let o = 0, s = 0, c = 0, l = 0, u = 0;
		for (let i = 0; i < n; i++) {
			let n = r(i, t), d = e.data[3 * i + a];
			o += n, s += d, c += n * n, l += d * d, u += n * d;
		}
		let d = c - o * o / n, f = l - s * s / n;
		d > 0 && f > 0 && (i = Math.max(i, Math.abs((u - o * s / n) / Math.sqrt(d * f))));
	}
	return i;
}
function he(e, t) {
	let n = fe(e.width, e.height);
	if (n === null) return {
		ok: !1,
		error: `A ${e.width} × ${e.height} image isn't a HaldCLUT: it must be square, 8 to 4096 pixels a side, a whole number cubed`
	};
	let r = n * n;
	for (let t = 0; t < e.data.length; t++) if (!Number.isFinite(e.data[t])) return {
		ok: !1,
		error: "The image has pixels that aren't numbers"
	};
	if (me(e, r) < pe) return {
		ok: !1,
		error: "The image is the size of a HaldCLUT, but its pixels don't follow a HaldCLUT's colour grid"
	};
	let i;
	if (r <= 65) {
		let t = new Float64Array(e.data.length);
		for (let n = 0; n < t.length; n++) t[n] = e.data[n] / e.scale;
		i = {
			size: r,
			lo: [
				0,
				0,
				0
			],
			hi: [
				1,
				1,
				1
			],
			data: t
		};
	} else i = ne(65, (t, n, i) => O(e.data, r, [
		t,
		n,
		i
	], e.scale).value);
	return {
		ok: !0,
		lut: {
			title: t,
			shaper: null,
			cube: i
		},
		level: n
	};
}
function ge(e, t) {
	if (e.size !== t * t) throw Error(`a level ${t} HaldCLUT needs ${t * t} nodes an axis`);
	let n = new Uint16Array(e.data.length);
	for (let t = 0; t < n.length; t++) n[t] = Math.round(Math.min(Math.max(e.data[t], 0), 1) * 65535);
	return n;
}
//#endregion
//#region src/zlib.ts
async function _e(e, t) {
	let n = t.writable.getWriter(), r = n.write(e).then(() => n.close()), i = t.readable.getReader(), a = [], o = 0;
	for (;;) {
		let { done: e, value: t } = await i.read();
		if (e) break;
		a.push(t), o += t.length;
	}
	await r;
	let s = new Uint8Array(o), c = 0;
	for (let e of a) s.set(e, c), c += e.length;
	return s;
}
var ve = (e) => _e(e, new DecompressionStream("deflate")), ye = (e) => _e(e, new CompressionStream("deflate")), M = null;
function be(e, t = 0, n = e.length) {
	if (!M) {
		M = /* @__PURE__ */ new Uint32Array(256);
		for (let e = 0; e < 256; e++) {
			let t = e;
			for (let e = 0; e < 8; e++) t = t & 1 ? 3988292384 ^ t >>> 1 : t >>> 1;
			M[e] = t >>> 0;
		}
	}
	let r = 4294967295;
	for (let i = t; i < n; i++) r = M[(r ^ e[i]) & 255] ^ r >>> 8;
	return (r ^ 4294967295) >>> 0;
}
//#endregion
//#region src/png.ts
var xe = [
	137,
	80,
	78,
	71,
	13,
	10,
	26,
	10
], Se = {
	0: 1,
	2: 3,
	3: 1,
	4: 2,
	6: 4
}, N = (e, t) => (e[t] << 24 | e[t + 1] << 16 | e[t + 2] << 8 | e[t + 3]) >>> 0;
function Ce(e, t, n) {
	let r = e + t - n, i = Math.abs(r - e), a = Math.abs(r - t), o = Math.abs(r - n);
	return i <= a && i <= o ? e : a <= o ? t : n;
}
function we(e, t, n, r) {
	let i = new Uint8Array(t * n);
	for (let a = 0; a < t; a++) {
		let t = e[a * (n + 1)], o = a * (n + 1) + 1, s = a * n, c = s - n;
		for (let l = 0; l < n; l++) {
			let n = e[o + l], u = l >= r ? i[s + l - r] : 0, d = a > 0 ? i[c + l] : 0, f = l >= r && a > 0 ? i[c + l - r] : 0;
			switch (t) {
				case 0:
					i[s + l] = n;
					break;
				case 1:
					i[s + l] = n + u;
					break;
				case 2:
					i[s + l] = n + d;
					break;
				case 3:
					i[s + l] = n + (u + d >> 1);
					break;
				case 4:
					i[s + l] = n + Ce(u, d, f);
					break;
				default: throw Error(`row ${a + 1} has an unknown filter (${t})`);
			}
		}
	}
	return i;
}
function Te(e) {
	return xe.every((t, n) => e[n] === t);
}
async function Ee(e) {
	if (!Te(e)) throw Error("it isn't a PNG file");
	let t = 8, n = 0, r = 0, i = 0, a = -1, o = null, s = [], c = !1;
	for (; t + 12 <= e.length;) {
		let l = N(e, t), u = String.fromCharCode(e[t + 4], e[t + 5], e[t + 6], e[t + 7]), d = t + 8, f = d + l;
		if (f + 4 > e.length) throw Error(`the ${u} chunk is cut short`);
		if (be(e, t + 4, f) !== N(e, f)) throw Error(`the ${u} chunk is damaged (checksum)`);
		let p = e.subarray(d, f);
		if (u === "IHDR") {
			if (n = N(p, 0), r = N(p, 4), i = p[8], a = p[9], p[10] !== 0 || p[11] !== 0) throw Error("it uses an unknown compression or filter method");
			if (p[12] !== 0) throw Error("interlaced PNGs aren't supported; save it without interlacing");
		} else if (u === "PLTE") o = p.slice();
		else if (u === "IDAT") s.push(p);
		else if (u === "IEND") {
			c = !0;
			break;
		} else if (u.charCodeAt(0) < 97) throw Error(`it has a chunk this reader doesn't know (${u})`);
		t = f + 4;
	}
	if (!c) throw Error("the file is cut short");
	if (n === 0 || r === 0) throw Error("it has no image header");
	let l = Se[a];
	if (l === void 0) throw Error(`it has an unknown colour type (${a})`);
	if (a === 0 || a === 4) throw Error("it is greyscale: a HaldCLUT needs colour");
	if (a === 3 ? i !== 8 : i !== 8 && i !== 16) throw Error(`${i}-bit samples of this colour type aren't supported`);
	if (a === 3 && !o) throw Error("its palette is missing");
	let u = s.reduce((e, t) => e + t.length, 0), d = new Uint8Array(u), f = 0;
	for (let e of s) d.set(e, f), f += e.length;
	let p;
	try {
		p = await ve(d);
	} catch {
		throw Error("its image data is damaged");
	}
	let m = i / 8 * l, h = n * m;
	if (p.length < r * (h + 1)) throw Error("its image data is cut short");
	let g = we(p, r, h, m), _ = n * r;
	if (i === 16) {
		let e = new Uint16Array(_ * 3);
		for (let t = 0; t < _; t++) {
			let n = t * m;
			for (let r = 0; r < 3; r++) e[3 * t + r] = g[n + 2 * r] << 8 | g[n + 2 * r + 1];
		}
		return {
			width: n,
			height: r,
			data: e,
			scale: 65535
		};
	}
	let v = new Uint8Array(_ * 3);
	for (let e = 0; e < _; e++) if (o) {
		let t = g[e] * 3;
		if (t + 3 > o.length) throw Error("a pixel names a colour the palette doesn't have");
		v.set(o.subarray(t, t + 3), 3 * e);
	} else {
		let t = e * m;
		v[3 * e] = g[t], v[3 * e + 1] = g[t + 1], v[3 * e + 2] = g[t + 2];
	}
	return {
		width: n,
		height: r,
		data: v,
		scale: 255
	};
}
function De(e, t) {
	let n = new Uint8Array(12 + t.length), r = new DataView(n.buffer);
	r.setUint32(0, t.length);
	for (let t = 0; t < 4; t++) n[4 + t] = e.charCodeAt(t);
	return n.set(t, 8), r.setUint32(8 + t.length, be(n, 4, 8 + t.length)), n;
}
async function Oe(e, t, n) {
	let r = e * 6, i = new Uint8Array(t * (r + 1));
	for (let a = 0; a < t; a++) {
		let t = a * (r + 1);
		for (let r = 0; r < e * 3; r++) {
			let o = n[a * e * 3 + r];
			i[t + 1 + 2 * r] = o >> 8, i[t + 2 + 2 * r] = o & 255;
		}
	}
	let a = /* @__PURE__ */ new Uint8Array(13), o = new DataView(a.buffer);
	o.setUint32(0, e), o.setUint32(4, t), a[8] = 16, a[9] = 2;
	let s = [
		Uint8Array.from(xe),
		De("IHDR", a),
		De("IDAT", await ye(i)),
		De("IEND", /* @__PURE__ */ new Uint8Array())
	], c = new Uint8Array(s.reduce((e, t) => e + t.length, 0)), l = 0;
	for (let e of s) c.set(e, l), l += e.length;
	return c;
}
//#endregion
//#region src/export-file.ts
var P = [
	{
		id: "cube-17",
		label: ".cube, 17 points",
		size: 17,
		hald: 0
	},
	{
		id: "cube-33",
		label: ".cube, 33 points",
		size: 33,
		hald: 0
	},
	{
		id: "cube-65",
		label: ".cube, 65 points",
		size: 65,
		hald: 0
	},
	{
		id: "hald-8",
		label: "HaldCLUT PNG, level 8",
		size: 64,
		hald: 8
	}
], ke = (e) => P.find((t) => t.id === e) ?? P[1];
function Ae(e) {
	let t = e.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
	return t === "" ? "Look" : t.slice(0, 120);
}
async function je(e, t, n, r) {
	let i = Ae(n);
	if (t.hald) {
		let n = await Oe(t.hald ** 3, t.hald ** 3, ge(e, t.hald));
		return {
			blob: new Blob([n], { type: "image/png" }),
			fileName: `${i}.png`
		};
	}
	let a = ["Made with LUT Tools for Safelight.", "Input and output: sRGB."];
	r.length > 0 && a.push(`Left out (not colour operations): ${r.join(", ")}.`);
	let o = de({
		title: n,
		shaper: null,
		cube: e
	}, a);
	return {
		blob: new Blob([o], { type: "text/plain" }),
		fileName: `${i}.cube`
	};
}
function Me(e, t) {
	let n = URL.createObjectURL(e), r = document.createElement("a");
	r.href = n, r.download = t, document.body.appendChild(r), r.click(), r.remove(), setTimeout(() => URL.revokeObjectURL(n), 1e4);
}
//#endregion
//#region src/params.ts
var F = "lut-tools", I = `${F}.look`, L = `${F}.bake`, Ne = [
	"active",
	"lut",
	"sig",
	"strength",
	"inEnc",
	"outEnc",
	"kind",
	"n3",
	"n1",
	"lo3",
	"hi3",
	"lo1",
	"hi1",
	"range3",
	"range1"
], R = (e) => `${I}.${e}`, z = `${I}.name`, B = "atlas", Pe = `${I}.${B}`;
function Fe(e) {
	return [Math.floor(e / 65536), e % 65536];
}
var Ie = (e) => typeof e == "number" && Number.isInteger(e) && e >= 0 && e <= 65535;
function Le(e) {
	return !Array.isArray(e) || e.length !== 2 || !Ie(e[0]) || !Ie(e[1]) || e[0] > 32767 ? 0 : e[0] * 65536 + e[1];
}
var V = {
	strength: 1,
	inEnc: 0,
	outEnc: 0
};
function Re(e, t, n, r, i) {
	return {
		[R("active")]: +(i.strength > 0),
		[R("lut")]: Fe(e),
		[R("sig")]: Fe(t),
		[R("strength")]: i.strength,
		[R("inEnc")]: i.inEnc,
		[R("outEnc")]: i.outEnc,
		[R("kind")]: n.kind,
		[R("n3")]: n.n3,
		[R("n1")]: n.n1,
		[R("lo3")]: [...n.lo3],
		[R("hi3")]: [...n.hi3],
		[R("lo1")]: [...n.lo1],
		[R("hi1")]: [...n.hi1],
		[R("range3")]: [...n.range3],
		[R("range1")]: [...n.range1],
		[z]: r,
		[Pe]: o(a(e))
	};
}
function ze() {
	let e = {
		[z]: void 0,
		[Pe]: void 0
	};
	for (let t of Ne) e[R(t)] = void 0;
	return e;
}
function Be(e, t) {
	return {
		[R("strength")]: t.strength,
		[R("inEnc")]: t.inEnc,
		[R("outEnc")]: t.outEnc,
		[R("active")]: +(e !== 0 && t.strength > 0)
	};
}
var Ve = (e, t) => typeof e == "number" && Number.isFinite(e) ? e : t;
function He(e) {
	let n = e(R("inEnc")), r = e(R("outEnc")), i = e(z);
	return {
		key: Le(e(R("lut"))),
		sig: Le(e(R("sig"))),
		name: typeof i == "string" ? i : null,
		settings: {
			strength: Math.min(1, Math.max(0, Ve(e(R("strength")), 1))),
			inEnc: t(n) ? n : 0,
			outEnc: t(r) ? r : 0
		}
	};
}
//#endregion
//#region src/stage.ts
var Ue = [
	{
		key: "active",
		glslType: "int",
		default: 0
	},
	{
		key: "lut",
		glslType: "vec2",
		default: [0, 0]
	},
	{
		key: "sig",
		glslType: "vec2",
		default: [0, 0]
	},
	{
		key: "strength",
		glslType: "float",
		default: V.strength,
		range: {
			min: 0,
			max: 1
		},
		label: "Strength"
	},
	{
		key: "inEnc",
		glslType: "int",
		default: V.inEnc
	},
	{
		key: "outEnc",
		glslType: "int",
		default: V.outEnc
	},
	{
		key: "kind",
		glslType: "int",
		default: 0
	},
	{
		key: "n3",
		glslType: "int",
		default: 2
	},
	{
		key: "n1",
		glslType: "float",
		default: 2
	},
	{
		key: "lo3",
		glslType: "vec3",
		default: [
			0,
			0,
			0
		]
	},
	{
		key: "hi3",
		glslType: "vec3",
		default: [
			1,
			1,
			1
		]
	},
	{
		key: "lo1",
		glslType: "vec3",
		default: [
			0,
			0,
			0
		]
	},
	{
		key: "hi1",
		glslType: "vec3",
		default: [
			1,
			1,
			1
		]
	},
	{
		key: "range3",
		glslType: "vec2",
		default: [0, 1]
	},
	{
		key: "range1",
		glslType: "vec2",
		default: [0, 1]
	}
], H = `${n}`, We = `
highp ivec2 ltTexel(highp int i) { return ivec2(i % ${H}, i / ${H}); }

highp uint ltWord(highp int i) {
  highp uvec4 b = uvec4(texelFetch(${B}, ltTexel(i), 0) * 255.0 + 0.5);
  return b.r | (b.g << 8u) | (b.b << 16u) | (b.a << 24u);
}

highp uint ltId(highp vec2 halves) {
  highp uint hi = uint(halves.x);
  highp uint lo = uint(halves.y);
  return (hi << 16u) | lo;
}

highp int ltFind(highp vec2 key, highp vec2 sig) {
  highp uint want = ltId(key);
  if (textureSize(${B}, 0).x != ${H} || want == 0u) return -1;
  highp uint slots = ltWord(0);
  if (slots < 8u) return -1;
  highp uint mask = slots - 1u;
  for (int p = 0; p < 4; p++) {
    highp int s = int((want + uint(p)) & mask);
    highp uint id = ltWord(1 + 3 * s);
    if (id == want) return ltWord(3 + 3 * s) == ltId(sig) ? int(ltWord(2 + 3 * s)) : -1;
    if (id == 0u) return -1;
  }
  return -1;
}

float ltShaper(highp int base, highp int m, int ch, float x, vec2 range) {
  float p = clamp(x, 0.0, 1.0) * float(m - 1);
  highp int i = min(int(p), m - 2);
  float f = p - float(i);
  vec4 t = floor(texelFetch(${B}, ltTexel(base + ch * (m - 1) + i), 0) * 255.0 + 0.5);
  return range.x + mix(t.r * 256.0 + t.g, t.b * 256.0 + t.a, f) * ((range.y - range.x) / 65535.0);
}

vec3 ltNode(highp int base, highp int n, highp ivec3 i, vec2 range) {
  highp int t = base + 2 * (i.x + n * (i.y + n * i.z));
  vec3 hi = floor(texelFetch(${B}, ltTexel(t), 0).rgb * 255.0 + 0.5);
  vec3 lo = floor(texelFetch(${B}, ltTexel(t + 1), 0).rgb * 255.0 + 0.5);
  return range.x + (hi * 256.0 + lo) * ((range.y - range.x) / 65535.0);
}

vec3 ltCube(highp int base, highp int n, vec3 u, vec2 range) {
  vec3 p = clamp(u, 0.0, 1.0) * float(n - 1);
  highp ivec3 i = min(ivec3(p), ivec3(n - 2));
  vec3 f = p - vec3(i);
  ivec3 o1;
  ivec3 o2;
  vec3 w;
  if (f.x >= f.y) {
    if (f.y >= f.z) { o1 = ivec3(1, 0, 0); o2 = ivec3(1, 1, 0); w = f.xyz; }
    else if (f.x >= f.z) { o1 = ivec3(1, 0, 0); o2 = ivec3(1, 0, 1); w = f.xzy; }
    else { o1 = ivec3(0, 0, 1); o2 = ivec3(1, 0, 1); w = f.zxy; }
  } else {
    if (f.z >= f.y) { o1 = ivec3(0, 0, 1); o2 = ivec3(0, 1, 1); w = f.zyx; }
    else if (f.z >= f.x) { o1 = ivec3(0, 1, 0); o2 = ivec3(0, 1, 1); w = f.yzx; }
    else { o1 = ivec3(0, 1, 0); o2 = ivec3(1, 1, 0); w = f.yxz; }
  }
  vec3 c0 = ltNode(base, n, i, range);
  vec3 c1 = ltNode(base, n, i + o1, range);
  vec3 c2 = ltNode(base, n, i + o2, range);
  vec3 c3 = ltNode(base, n, i + ivec3(1), range);
  return c0 + w.x * (c1 - c0) + w.y * (c2 - c1) + w.z * (c3 - c2);
}

vec3 ltDecode(vec3 v, int enc) {
  vec3 a = abs(v);
  vec3 l = a;
  if (enc == 0) l = mix(pow((a + 0.055) / 1.055, vec3(2.4)), a / 12.92, vec3(lessThanEqual(a, vec3(0.04045))));
  else if (enc == 1) l = pow(max(a, vec3(1e-30)), vec3(2.4));
  else if (enc == 2) l = pow(max(a, vec3(1e-30)), vec3(2.2));
  return sign(v) * l;
}

vec3 ltEncode(vec3 v, int enc) {
  vec3 a = abs(v);
  vec3 e = a;
  if (enc == 0) e = mix(1.055 * pow(max(a, vec3(1e-30)), vec3(1.0 / 2.4)) - 0.055, a * 12.92, vec3(lessThanEqual(a, vec3(0.0031308))));
  else if (enc == 1) e = pow(max(a, vec3(1e-30)), vec3(1.0 / 2.4));
  else if (enc == 2) e = pow(max(a, vec3(1e-30)), vec3(1.0 / 2.2));
  return sign(v) * e;
}
`, Ge = "\nif (active != 0 && strength > 0.0) {\n  highp int base = ltFind(lut, sig);\n  if (base >= 0) {\n    highp int m1 = int(n1);\n    vec3 light = ltDecode(c, 0);\n    vec3 e = inEnc == 0 ? c : ltEncode(light, inEnc);\n    bool shaped = (kind & 1) != 0;\n    vec3 ec = shaped ? clamp(e, lo1, hi1) : clamp(e, lo3, hi3);\n    vec3 v = ec;\n    if (shaped) {\n      vec3 x = (ec - lo1) / (hi1 - lo1);\n      v = vec3(ltShaper(base, m1, 0, x.x, range1), ltShaper(base, m1, 1, x.y, range1), ltShaper(base, m1, 2, x.z, range1));\n    }\n    if ((kind & 2) != 0) {\n      highp int base3 = base + (shaped ? 3 * (m1 - 1) : 0);\n      v = ltCube(base3, n3, (clamp(v, lo3, hi3) - lo3) / (hi3 - lo3), range3);\n    }\n    vec3 graded = v;\n    if (outEnc != 0 || any(notEqual(e, ec))) graded = ltEncode(ltDecode(v, outEnc) + (light - ltDecode(ec, inEnc)), 0);\n    c = mix(c, graded, strength);\n  }\n}\n";
function Ke() {
	return {
		id: I,
		name: "LUT",
		phase: "display-adjust",
		priority: 900,
		space: { encoding: "perceptual" },
		uniforms: Ue.map((e) => ({ ...e })),
		textures: [{
			key: B,
			kind: "lut",
			format: "rgba8"
		}],
		helpers: We,
		glsl: Ge,
		dormantWhen: { active: 0 }
	};
}
var U = (e) => `${L}.${e}`, qe = "\nvec3 ltGridLight(vec3 g) {\n  return mix(pow((g + 0.055) / 1.055, vec3(2.4)), g / 12.92, vec3(lessThanEqual(g, vec3(0.04045))));\n}\n", Je = "\nif (bake != 0) {\n  highp ivec2 cell = clamp(ivec2(vUv * vec2(gridCells)), ivec2(0), gridCells - 1);\n  highp int k = int(gridStart) + cell.y * gridCells.x + cell.x;\n  highp int n = gridSize;\n  vec3 g = vec3(0.0);\n  if (k < n * n * n) g = vec3(float(k % n), float((k / n) % n), float(k / (n * n))) * (gridTop / float(n - 1));\n  lin = ltGridLight(g);\n}\n";
function Ye() {
	return {
		id: L,
		name: "LUT export grid",
		phase: "decode",
		priority: 0,
		uniforms: [
			{
				key: "bake",
				glslType: "int",
				default: 0
			},
			{
				key: "gridSize",
				glslType: "int",
				default: 2
			},
			{
				key: "gridCells",
				glslType: "ivec2",
				default: [1, 1]
			},
			{
				key: "gridStart",
				glslType: "float",
				default: 0
			},
			{
				key: "gridTop",
				glslType: "float",
				default: 1
			}
		],
		helpers: qe,
		glsl: Je,
		dormantWhen: { bake: 0 },
		presetScope: "per-image"
	};
}
//#endregion
//#region src/bake.ts
var W = .99, Xe = [
	"highlights",
	"shadows",
	"highlightDetail",
	"shadowDetail",
	"texture",
	"clarity",
	"dehaze",
	"sharpening",
	"luminanceNR",
	"colorNR"
], Ze = [
	"vignette",
	"grain",
	"masks",
	"retouch",
	"crop",
	"straighten",
	"transform",
	"uprightMode",
	"guidedLines"
], Qe = /\b(srcUv|sensorUv|vUv|gl_FragCoord|uImage|readSource|stageResult|uImageAspect|rawLuma|lumaLod|uViewport)\b/, $e = /\b(readSource|fetchInput)\b/, et = /\b(readPrev|readPrev4|fetchPrev4)\b/, tt = (e) => `${e.glsl}\n${e.helpers ?? ""}`;
function nt(e) {
	if (e.phase === "geometry") return !0;
	let t = e.passes ?? [];
	return t.some((e) => $e.test(tt(e))) || t.length > 0 && et.test(tt(t[0])) || (e.textures ?? []).some((e) => e.kind === "coverage" || e.kind === "paint" || e.kind === "atlas") ? !0 : Qe.test(e.glsl) || Qe.test(e.helpers ?? "");
}
var rt = (e, t) => JSON.stringify(e) !== JSON.stringify(t);
function it(e) {
	let t = {};
	for (let e of Xe) t[e] = 0;
	for (let n of Ze) Object.assign(t, { [n]: e[n] });
	return t.vignette = {
		...e.vignette,
		amount: 0
	}, t.grain = {
		...e.grain,
		amount: 0
	}, t;
}
function at(e, t) {
	let n = it(t.normalizeParams({ processVersion: e.params.processVersion })), r = [];
	for (let i of Object.keys(n)) {
		if (!rt(e.params[i], n[i])) continue;
		let a = t.summarize({ [i]: e.params[i] }), o = (a.length > 0 ? a : t.summarize({ [i]: n[i] }))[0]?.label;
		o && !r.includes(o) && r.push(o);
	}
	let i = { ...e.bag };
	for (let n of e.stages) {
		if (n.id === "lut-tools.bake" || n.extensionId === "lut-tools" || t.isOfficial(n.extensionId) || !nt(n)) continue;
		let e = !1;
		for (let t of [...n.uniforms, ...(n.passes ?? []).flatMap((e) => e.uniforms ?? [])]) {
			let r = `${n.id}.${t.key}`;
			r in i && rt(i[r], t.default) && (e = !0), i[r] = t.default;
		}
		for (let t of n.textures ?? []) if (t.kind === "coverage" || t.kind === "paint") {
			let r = `${n.id}.${t.key}`;
			Array.isArray(i[r]) && i[r].length > 0 && (e = !0), delete i[r];
		}
		e && !r.includes(n.name) && r.push(n.name);
	}
	let a = t.normalizeParams({
		temperature: e.asShotTemperature,
		processVersion: e.params.processVersion
	});
	return {
		edit: {
			params: {
				...e.params,
				...n
			},
			bag: i
		},
		plain: {
			params: {
				...a,
				...n
			},
			bag: {}
		},
		leftOut: r
	};
}
function ot(e, t) {
	return {
		cellsX: Math.max(1, Math.floor(e / 3)),
		cellsY: Math.max(1, Math.floor(t / 3))
	};
}
function G(e, t, n) {
	return {
		[U("bake")]: 1,
		[U("gridSize")]: e,
		[U("gridCells")]: [t.cellsX, t.cellsY],
		[U("gridStart")]: n,
		[U("gridTop")]: W
	};
}
function st(e, t) {
	let n = W / (t - 1);
	return [
		e % t * n,
		Math.floor(e / t) % t * n,
		Math.floor(e / (t * t)) * n
	];
}
function ct(e, t, n) {
	let r = new Float64Array(3 * t.cellsX * t.cellsY);
	for (let i = 0; i < t.cellsY; i++) {
		let a = Math.floor((i + .5) * e.height / t.cellsY), o = n ? e.height - 1 - a : a;
		for (let n = 0; n < t.cellsX; n++) {
			let a = Math.floor((n + .5) * e.width / t.cellsX), s = 4 * (o * e.width + a), c = 3 * (i * t.cellsX + n);
			r[c] = e.data[s], r[c + 1] = e.data[s + 1], r[c + 2] = e.data[s + 2];
		}
	}
	return r;
}
function lt(e, t) {
	let [n, r, i, a, o, s, c, l, u] = e, d = n * (o * u - s * l) - r * (a * u - s * c) + i * (a * l - o * c);
	if (!Number.isFinite(d) || Math.abs(d) < 1e-300) return null;
	let f = 1 / d;
	return [
		(t[0] * (o * u - s * l) - r * (t[1] * u - s * t[2]) + i * (t[1] * l - o * t[2])) * f,
		(n * (t[1] * u - s * t[2]) - t[0] * (a * u - s * c) + i * (a * t[2] - t[1] * c)) * f,
		(n * (o * t[2] - t[1] * l) - r * (a * t[2] - t[1] * c) + t[0] * (a * l - o * c)) * f
	];
}
var ut = (e) => e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
function dt(e, t, n, r) {
	let i = [...r], a = O(e, t, i), o = [
		a.value[0] - n[0],
		a.value[1] - n[1],
		a.value[2] - n[2]
	], s = ut(o), c = 1e-9;
	for (let r = 0; r < 60 && s > 1e-16; r++) {
		let r = a.jac, l = Array(9), u = [
			0,
			0,
			0
		];
		for (let e = 0; e < 3; e++) {
			for (let t = 0; t < 3; t++) l[3 * e + t] = r[3 * e] * r[3 * t] + r[3 * e + 1] * r[3 * t + 1] + r[3 * e + 2] * r[3 * t + 2];
			u[e] = -(r[3 * e] * o[0] + r[3 * e + 1] * o[1] + r[3 * e + 2] * o[2]);
		}
		let d = !1;
		for (let r = 0; r < 12 && !d; r++) {
			let r = lt(l.map((e, t) => t % 4 == 0 ? e + c * (e + 1e-12) : e), u);
			if (r) {
				let l = [
					0,
					1,
					2
				].map((e) => Math.min(1.5, Math.max(-.5, i[e] + r[e]))), u = O(e, t, l), f = [
					u.value[0] - n[0],
					u.value[1] - n[1],
					u.value[2] - n[2]
				], p = ut(f);
				if (p < s) {
					i = l, a = u, o = f, s = p, c = Math.max(c * .1, 1e-12), d = !0;
					continue;
				}
			}
			c = Math.max(c * 10, 1e-6);
		}
		if (!d) break;
	}
	return {
		t: i,
		residual: Math.sqrt(s)
	};
}
async function ft(e, t, n, r) {
	let i = new Float64Array(3 * n ** 3), a = 0, o = 1 / W;
	for (let s = 0; s < n; s++) {
		for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
			let l = [
				c / (n - 1),
				r / (n - 1),
				s / (n - 1)
			], { t: u, residual: d } = dt(e, n, l, [
				l[0] * o,
				l[1] * o,
				l[2] * o
			]), f = O(t, n, u).value, p = 3 * (c + n * (r + n * s));
			i[p] = f[0], i[p + 1] = f[1], i[p + 2] = f[2], d > a && (a = d);
		}
		r?.((s + 1) / n), await new Promise((e) => setTimeout(e, 0));
	}
	return {
		table: {
			size: n,
			lo: [
				0,
				0,
				0
			],
			hi: [
				1,
				1,
				1
			],
			data: i
		},
		worstResidual: a
	};
}
async function pt(e, t, n, r, i, a, o) {
	let s = r ** 3, c = i.cellsX * i.cellsY, l = new Float64Array(3 * s);
	for (let u = 0; u < s; u += c) {
		let d = await e(t, {
			...n,
			...G(r, i, u)
		});
		if (!d) throw Error("the photo couldn't be rendered");
		let f = ct(d, i, a);
		l.set(f.subarray(0, 3 * Math.min(c, s - u)), 3 * u), o();
	}
	return l;
}
function mt(e, t, n) {
	let r = (r) => {
		let i = ct(e, t, r), a = 0, o = Math.min(t.cellsX * t.cellsY, n ** 3);
		for (let e = 0; e < o; e++) {
			let t = st(e, n);
			for (let n = 0; n < 3; n++) a += (i[3 * e + n] - t[n]) ** 2;
		}
		return a;
	};
	return r(!0) < r(!1);
}
async function ht(e, t, n, r) {
	let i = await n(e.plain.params, {
		...e.plain.bag,
		...G(t, {
			cellsX: 1,
			cellsY: 1
		}, 0)
	});
	if (!i) throw Error("the photo couldn't be rendered");
	let a = ot(i.width, i.height), o = await n(e.plain.params, {
		...e.plain.bag,
		...G(t, a, 0)
	});
	if (!o) throw Error("the photo couldn't be rendered");
	let s = mt(o, a, t), c = Math.ceil(t ** 3 / (a.cellsX * a.cellsY)), l = 0, u = () => r(.6 * ++l / (2 * c)), d = await ft(await pt(n, e.plain.params, e.plain.bag, t, a, s, u), await pt(n, e.edit.params, e.edit.bag, t, a, s, u), t, (e) => r(.6 + .4 * e));
	return {
		table: d.table,
		leftOut: e.leftOut,
		worstResidual: d.worstResidual
	};
}
//#endregion
//#region src/tiff.ts
var K = {
	width: 256,
	height: 257,
	bits: 258,
	compression: 259,
	photometric: 262,
	stripOffsets: 273,
	samples: 277,
	rowsPerStrip: 278,
	stripBytes: 279,
	planar: 284,
	predictor: 317,
	tileWidth: 322,
	sampleFormat: 339
}, gt = {
	1: 1,
	2: 1,
	3: 2,
	4: 4,
	5: 8,
	6: 1,
	7: 1,
	8: 2,
	9: 4,
	10: 8,
	11: 4,
	12: 8
};
function _t(e) {
	return e[0] === 73 && e[1] === 73 && e[2] === 42 && e[3] === 0 || e[0] === 77 && e[1] === 77 && e[2] === 0 && e[3] === 42;
}
function vt(e, t) {
	let n = /* @__PURE__ */ new Int32Array(4096), r = /* @__PURE__ */ new Uint8Array(4096), i = /* @__PURE__ */ new Uint16Array(4096), a = /* @__PURE__ */ new Uint8Array(4096);
	for (let e = 0; e < 256; e++) n[e] = -1, r[e] = e, i[e] = 1, a[e] = e;
	let o = new Uint8Array(Math.max(t, 1)), s = 0, c = 0, l = 9, u = 258, d = -1, f = e.length * 8, p = () => {
		if (c + l > f) return 257;
		let t = 0;
		for (let n = 0; n < l; n++) {
			let r = c + n;
			t = t << 1 | e[r >> 3] >> 7 - (r & 7) & 1;
		}
		return c += l, t;
	}, m = (e) => {
		let t = i[e];
		if (s + t > o.length) {
			let e = new Uint8Array(Math.max(o.length * 2, s + t));
			e.set(o), o = e;
		}
		let a = e;
		for (let e = t - 1; e >= 0; e--) o[s + e] = r[a], a = n[a];
		s += t;
	}, h = (e, t) => {
		u >= 4096 || (n[u] = e, r[u] = t, i[u] = i[e] + 1, a[u] = a[e], u++, u === (1 << l) - 1 && l < 12 && l++);
	};
	for (;;) {
		let e = p();
		if (e === 257) break;
		if (e === 256) u = 258, l = 9, d = -1;
		else {
			if (d === -1) {
				if (e > 255) throw Error("its LZW data is damaged");
				m(e);
			} else if (e < u) m(e), h(d, a[e]);
			else if (e === u) h(d, a[d]), m(e);
			else throw Error("its LZW data is damaged");
			d = e;
		}
	}
	return o.subarray(0, s);
}
function yt(e, t) {
	let n = new Uint8Array(t), r = 0, i = 0;
	for (; i < e.length && r < t;) {
		let a = e[i++] << 24 >> 24;
		if (a >= 0) for (let o = 0; o <= a && r < t; o++) n[r++] = e[i++];
		else if (a !== -128) {
			let o = e[i++];
			for (let e = 0; e < 1 - a && r < t; e++) n[r++] = o;
		}
	}
	return n;
}
async function bt(e) {
	if (!_t(e)) throw Error("it isn't a TIFF file");
	let t = new DataView(e.buffer, e.byteOffset, e.byteLength), n = e[0] === 73, r = (e) => t.getUint16(e, n), i = (e) => t.getUint32(e, n), a = i(4);
	if (a + 2 > e.length) throw Error("the file is cut short");
	let o = r(a), s = /* @__PURE__ */ new Map();
	for (let t = 0; t < o; t++) {
		let n = a + 2 + 12 * t;
		if (n + 12 > e.length) throw Error("the file is cut short");
		let o = r(n), c = r(n + 2), l = i(n + 4), u = gt[c] ?? 0;
		if (c !== 3 && c !== 4) continue;
		let d = u * l <= 4 ? n + 8 : i(n + 8);
		if (d + u * l > e.length) throw Error("the file is cut short");
		let f = [];
		for (let e = 0; e < l; e++) f.push(c === 3 ? r(d + 2 * e) : i(d + 4 * e));
		s.set(o, f);
	}
	let c = (e, t) => {
		let n = s.get(e)?.[0] ?? t;
		if (n === void 0) throw Error(`it lacks a required field (tag ${e})`);
		return n;
	}, l = c(K.width), u = c(K.height), d = c(K.samples, 1), f = s.get(K.bits) ?? [1], p = f[0], m = c(K.compression, 1), h = c(K.predictor, 1), g = c(K.sampleFormat, 1);
	if (s.has(K.tileWidth)) throw Error("tiled TIFFs aren't supported; save it in strips");
	if (c(K.planar, 1) !== 1) throw Error("TIFFs with separate colour planes aren't supported");
	if (c(K.photometric, 2) !== 2 || d < 3) throw Error("it isn't an RGB image");
	if (f.some((e) => e !== p)) throw Error("its channels have different bit depths");
	let _ = g === 3 && p === 32 ? "float" : g === 1 && (p === 8 || p === 16) ? "uint" : null;
	if (!_) throw Error(`${p}-bit ${g === 3 ? "floating-point" : "integer"} samples aren't supported`);
	if (h !== 1 && (h !== 2 || _ !== "uint")) throw Error("its predictor isn't supported");
	let v = s.get(K.stripOffsets), y = s.get(K.stripBytes);
	if (!v || !y || v.length !== y.length) throw Error("its strips are missing");
	let b = Math.min(c(K.rowsPerStrip, u), u), x = p / 8, S = l * d * x, C = new Uint8Array(S * u);
	for (let t = 0; t < v.length; t++) {
		let n = Math.min(b, u - t * b);
		if (n <= 0) break;
		let r = n * S;
		if (v[t] + y[t] > e.length) throw Error("a strip runs past the end of the file");
		let i = e.subarray(v[t], v[t] + y[t]), a;
		if (m === 1) a = i;
		else if (m === 5) a = vt(i, r);
		else if (m === 8 || m === 32946) try {
			a = await ve(i);
		} catch {
			throw Error("its Deflate data is damaged");
		}
		else if (m === 32773) a = yt(i, r);
		else throw Error(`its compression (${m}) isn't supported`);
		if (a.length < r) throw Error("a strip is cut short");
		C.set(a.subarray(0, r), t * b * S);
	}
	let w = l * u, T = new DataView(C.buffer);
	if (_ === "float") {
		let e = new Float32Array(w * 3);
		for (let t = 0; t < w; t++) for (let r = 0; r < 3; r++) e[3 * t + r] = T.getFloat32((t * d + r) * 4, n);
		return {
			width: l,
			height: u,
			data: e,
			scale: 1
		};
	}
	let E = p === 16 ? new Uint16Array(w * d) : C;
	if (p === 16) for (let e = 0; e < E.length; e++) E[e] = T.getUint16(2 * e, n);
	if (h === 2) {
		let e = p === 16 ? 65535 : 255;
		for (let t = 0; t < u; t++) for (let n = 1; n < l; n++) for (let r = 0; r < d; r++) {
			let i = (t * l + n) * d + r;
			E[i] = E[i] + E[i - d] & e;
		}
	}
	let D = p === 16 ? new Uint16Array(w * 3) : new Uint8Array(w * 3);
	for (let e = 0; e < w; e++) for (let t = 0; t < 3; t++) D[3 * e + t] = E[e * d + t];
	return {
		width: l,
		height: u,
		data: D,
		scale: p === 16 ? 65535 : 255
	};
}
//#endregion
//#region src/read-file.ts
var xt = [
	".cube",
	".png",
	".tif",
	".tiff",
	".jpg",
	".jpeg"
];
function St(e) {
	let t = e.toLowerCase();
	return xt.some((e) => t.endsWith(e));
}
var Ct = (e) => e[0] === 255 && e[1] === 216 && e[2] === 255;
function wt(e) {
	let t = e.split(/[\\/]/).pop() ?? e, n = t.lastIndexOf(".");
	return n > 0 ? t.slice(0, n) : t;
}
async function Tt(e) {
	let t = await crypto.subtle.digest("SHA-256", e);
	return [...new Uint8Array(t)].map((e) => e.toString(16).padStart(2, "0")).join("");
}
function Et(e) {
	return e === null || e.data.every(Number.isFinite);
}
async function Dt(e, t, n) {
	let r = wt(e), i = [], a, o;
	if (e.toLowerCase().endsWith(".cube")) {
		let e;
		try {
			e = new TextDecoder("utf-8", { fatal: !0 }).decode(t);
		} catch {
			return {
				ok: !1,
				error: "The file isn't text, so it can't be a .cube LUT"
			};
		}
		let n = ue(e, r);
		if (!n.ok) return n;
		a = n.lut, o = "cube", n.axisOrder === "blue-fastest" && i.push("Its entries run blue fastest; read in that order.");
	} else {
		let e;
		try {
			if (Te(t)) e = await Ee(t);
			else if (_t(t)) e = await bt(t);
			else if (Ct(t)) e = await n(t);
			else return {
				ok: !1,
				error: "The file isn't a .cube LUT or a PNG, TIFF or JPEG HaldCLUT"
			};
		} catch (e) {
			return {
				ok: !1,
				error: `The image can't be read: ${e instanceof Error ? e.message : String(e)}`
			};
		}
		let s = he(e, r);
		if (!s.ok) return s;
		a = s.lut, o = "hald", s.level * s.level > 65 && i.push(`Level ${s.level} is resampled to 65 nodes an axis.`);
	}
	return !Et(a.shaper) || !Et(a.cube) ? {
		ok: !1,
		error: "The table holds values that aren't numbers"
	} : (a.cube && a.cube.size > 65 && (i.push(`Its ${a.cube.size}-node table is resampled to 65 nodes an axis.`), a = {
		...a,
		cube: re(a.cube, 65)
	}), {
		ok: !0,
		lut: a,
		format: o,
		hash: await Tt(t),
		notes: i
	});
}
var Ot = async (e) => {
	let t = await createImageBitmap(new Blob([e], { type: "image/jpeg" }), {
		colorSpaceConversion: "none",
		premultiplyAlpha: "none"
	}), n = new OffscreenCanvas(t.width, t.height), r = n.getContext("2d");
	if (!r) throw Error("no canvas to decode it on");
	r.drawImage(t, 0, 0);
	let i = r.getImageData(0, 0, t.width, t.height).data, a = new Uint8Array(t.width * t.height * 3);
	for (let e = 0; e < a.length / 3; e++) a[3 * e] = i[4 * e], a[3 * e + 1] = i[4 * e + 1], a[3 * e + 2] = i[4 * e + 2];
	return t.close(), {
		width: n.width,
		height: n.height,
		data: a,
		scale: 255
	};
}, kt = (e) => e === "core" || e.startsWith("core.") || e === "safelight" || e.startsWith("safelight.");
async function At(e, t, n, r, i) {
	let a = e.stores.useDevelopStore.getState();
	if (a.photoId !== t.id) throw Error("the photo isn't open in Develop");
	let o = await ht(at({
		params: a.params,
		bag: a.paramBag,
		stages: n,
		asShotTemperature: t.exif.colorTemperature
	}, {
		normalizeParams: (t) => e.develop.normalizeParams(t),
		summarize: (t) => e.presets.summarize(t),
		isOfficial: kt
	}), r.size, (n, r) => e.develop.renderPhotoFloatFrame(t.id, n, {
		paramBag: r,
		point: "pre-output",
		space: {
			encoding: "perceptual",
			primaries: "rec709"
		}
	}), i), s = `${wt(t.filename)} look`;
	return {
		...await je(o.table, r, s, o.leftOut),
		leftOut: o.leftOut
	};
}
//#endregion
//#region src/rt.ts
var q, J;
function jt(e) {
	J = e, q = e.react;
}
//#endregion
//#region src/styles.ts
var Y = "lut-tools", X = {
	toolbar: `${Y}-toolbar`,
	tool: `${Y}-tool`,
	search: `${Y}-search`,
	empty: `${Y}-empty`,
	note: `${Y}-note`,
	warning: `${Y}-warning`,
	sections: `${Y}-sections`,
	rows: `${Y}-rows`,
	groupHeader: `${Y}-group-header`,
	caret: `${Y}-caret`,
	groupName: `${Y}-group-name`,
	count: `${Y}-count`,
	row: `${Y}-row`,
	current: `${Y}-current`,
	apply: `${Y}-apply`,
	delete: `${Y}-delete`,
	rename: `${Y}-rename`
}, Mt = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap;", Nt = [
	X.tool,
	X.empty,
	X.note,
	X.warning,
	X.groupHeader
], Pt = [
	X.row,
	X.search,
	X.rename
], Ft = (e) => e.map((e) => `html.sl-larger-text .${e}`).join(", ");
function It(e) {
	return `
:where(.${X.toolbar}) { margin-bottom: 0.5rem; display: flex; gap: 0.25rem; }
:where(.${X.tool}) { flex: 1; border-radius: 0.25rem; background-color: ${e.surface2}; padding: 0.25rem 0.5rem; font-size: 10px; color: ${e.textSecondary}; }
:where(.${X.search}), :where(.${X.rename}) { width: 100%; border-radius: 0.25rem; background-color: ${e.surface2}; padding: 0.25rem 0.5rem; font-size: 11px; color: ${e.textPrimary}; }
:where(.${X.search}) { margin-bottom: 0.5rem; }
:where(.${X.search}:focus), :where(.${X.rename}:focus) { outline-style: none; }
:where(.${X.empty}) { font-size: 10px; color: ${e.textMuted}; }
:where(.${X.note}) { font-size: 10px; line-height: 1.375; color: ${e.textMuted}; }
:where(.${X.warning}) { border-radius: 0.25rem; background-color: ${e.surface2}; padding: 0.375rem 0.5rem; font-size: 10px; line-height: 1.375; color: ${e.textSecondary}; }
:where(.${X.sections} > :not(:last-child)) { margin-block: 0 0.25rem; }
:where(.${X.rows} > :not(:last-child)) { margin-block: 0 0.125rem; }
:where(.${X.groupHeader}) { display: flex; width: 100%; align-items: center; gap: 0.25rem; padding: 0.125rem 0.25rem; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.025em; color: ${e.textMuted}; }
:where(.${X.caret}) { display: inline-block; width: 0.75rem; }
:where(.${X.groupName}) { ${Mt} }
:where(.${X.count}) { margin-left: auto; font-variant-numeric: tabular-nums; opacity: 0.6; }
:where(.${X.row}) { position: relative; display: flex; align-items: center; justify-content: space-between; border-radius: 0.25rem; padding: 0.25rem 0.5rem; font-size: 11px; color: ${e.textSecondary}; }
:where(.${X.current}) { background-color: ${e.surface3}; color: ${e.textPrimary}; }
:where(.${X.apply}) { min-width: 0; flex: 1; ${Mt} text-align: left; }
:where(.${X.delete}) { margin-left: 0.25rem; color: ${e.textMuted}; opacity: 0; }

@media (hover: hover) {
  :where(.${X.tool}:hover) { background-color: ${e.surface3}; color: ${e.textPrimary}; }
  :where(.${X.groupHeader}:hover) { color: ${e.textSecondary}; }
  :where(.${X.row}:hover) { background-color: ${e.surface2}; }
  :where(.${X.apply}:hover) { color: ${e.textPrimary}; }
  :where(.${X.delete}:hover) { color: ${e.labelRed}; }
  :where(.${X.row}:hover .${X.delete}) { opacity: 1; }
}

${Ft(Nt)} { font-size: 12px !important; }
${Ft(Pt)} { font-size: 13px !important; line-height: 1.45 !important; }
html.sl-larger-text .${X.groupHeader} { text-transform: none !important; }
html.sl-title-headings .${X.groupHeader} { text-transform: capitalize !important; }
`;
}
//#endregion
//#region src/Panel.tsx
function Lt(e) {
	return q.useSyncExternalStore(e.subscribe, e.revision);
}
function Rt(e, t) {
	if (e.key === 0) return { kind: "none" };
	let n = t.byKey(e.key);
	return n && n.sig === e.sig ? {
		kind: "applied",
		entry: n
	} : {
		kind: "missing",
		name: e.name
	};
}
function zt(e, t) {
	let n = Re(e.key, e.sig, e.layout, e.name, {
		strength: t,
		inEnc: e.inEnc,
		outEnc: e.outEnc
	});
	return delete n[z], n;
}
var Bt = e.map((e) => ({
	value: String(e.id),
	label: e.label
}));
function Vt(e, t) {
	let n = t.trim().toLowerCase(), r = n ? e.filter((e) => e.name.toLowerCase().includes(n) || e.folder.toLowerCase().includes(n)) : e, i = /* @__PURE__ */ new Map();
	for (let e of r) {
		let t = i.get(e.folder);
		t ? t.push(e) : i.set(e.folder, [e]);
	}
	return [...i].map(([e, t]) => ({
		folder: e,
		items: t
	}));
}
async function Ht(e) {
	if (e.refused.length === 0 && e.notes.length === 0) return;
	let t = [];
	e.added.length > 0 && t.push(`Added ${e.added.length} LUT${e.added.length === 1 ? "" : "s"}.`);
	for (let n of e.notes) t.push(`${n.name}: ${n.note}`);
	if (e.refused.length > 0) {
		t.push(`${e.refused.length === 1 ? "One file wasn't" : `${e.refused.length} files weren't`} added:`);
		for (let n of e.refused.slice(0, 12)) t.push(`${n.name}: ${n.reason}`);
		e.refused.length > 12 && t.push(`…and ${e.refused.length - 12} more.`);
	}
	await J.ui.alertDialog({
		title: e.added.length > 0 ? "LUTs added" : "No LUTs added",
		message: t.join("\n")
	});
}
function Ut({ library: e, look: n, state: r }) {
	let { Select: i, Button: a, Field: o, Stack: s, Row: c } = J.ui, { Slider: l } = J.components, u = J.develop.useParamScope(), d = (e, t) => {
		u.setParams(Be(n.key, e)), t && u.commit(t);
	}, f = (i, a) => {
		let o = Number(a);
		if (!t(o)) return;
		let s = {
			...n.settings,
			[i]: o
		};
		d(s, "LUT encoding"), r.kind === "applied" && e.setEncodings(r.entry.id, s.inEnc, s.outEnc);
	};
	return r.kind === "none" ? /* @__PURE__ */ q.createElement("p", { className: X.note }, "No LUT on this photo. Pick one from the library below.") : /* @__PURE__ */ q.createElement(s, { gap: 6 }, r.kind === "missing" ? /* @__PURE__ */ q.createElement("div", {
		className: X.warning,
		role: "status"
	}, r.name ? `“${r.name}”` : "This photo's LUT", " isn't in the LUT library, so the photo is drawn without it. Add its file again to bring it back.") : null, /* @__PURE__ */ q.createElement(c, {
		gap: 6,
		justify: "space-between"
	}, /* @__PURE__ */ q.createElement("span", { style: {
		fontSize: 11,
		color: J.ui.tokens.textPrimary,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	} }, r.kind === "applied" ? r.entry.name : r.name ?? "Missing LUT"), /* @__PURE__ */ q.createElement(a, {
		size: "sm",
		variant: "ghost",
		onClick: () => {
			u.setParams(ze()), u.commit("Remove LUT");
		}
	}, "Remove")), /* @__PURE__ */ q.createElement(l, {
		label: "Strength",
		value: Math.round(n.settings.strength * 100),
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 100,
		onChange: (e) => d({
			...n.settings,
			strength: e / 100
		}, null),
		onCommit: () => u.commit("LUT strength")
	}), /* @__PURE__ */ q.createElement(o, {
		label: "Input",
		hint: "The encoding the LUT expects. Most looks and film simulations expect sRGB."
	}, /* @__PURE__ */ q.createElement(i, {
		ariaLabel: "LUT input encoding",
		value: String(n.settings.inEnc),
		options: Bt,
		onChange: (e) => f("inEnc", e)
	})), /* @__PURE__ */ q.createElement(o, {
		label: "Output",
		hint: "The encoding the LUT produces."
	}, /* @__PURE__ */ q.createElement(i, {
		ariaLabel: "LUT output encoding",
		value: String(n.settings.outEnc),
		options: Bt,
		onChange: (e) => f("outEnc", e)
	})));
}
function Wt({ library: e, look: t, current: n }) {
	Lt(e);
	let { ContextMenu: r } = J.components, i = J.develop.useParamScope(), [a, o] = q.useState(""), [s, c] = q.useState(/* @__PURE__ */ new Set()), [l, u] = q.useState(null), [d, f] = q.useState(null), [p, m] = q.useState(null), h = q.useRef(null), g = q.useRef(null);
	q.useEffect(() => (g.current?.setAttribute("webkitdirectory", ""), () => J.develop.setViewValues(null)), []);
	let _ = t.key === 0 ? 1 : t.settings.strength, v = (e) => J.develop.setViewValues(e ? zt(e, _) : null), y = (e) => {
		v(null), i.setParams(Re(e.key, e.sig, e.layout, e.name, {
			strength: t.key === 0 ? 1 : t.settings.strength || 1,
			inEnc: e.inEnc,
			outEnc: e.outEnc
		})), i.commit("LUT");
	}, b = async (t) => {
		let n = [...t?.files ?? []].filter((e) => St(e.name));
		if (t && (t.value = ""), n.length !== 0) try {
			await Ht(await e.add(n.map((e) => ({
				path: e.webkitRelativePath || e.name,
				bytes: async () => new Uint8Array(await e.arrayBuffer())
			})), (e, t) => m(e < t ? `Adding ${e + 1} of ${t}…` : null)));
		} finally {
			m(null);
		}
	}, x = async (t, n) => {
		await J.ui.confirmDialog({
			title: `Remove ${n} from the library?`,
			message: "Photos that use it keep their settings but are drawn without it, and say so, until you add the file again.",
			confirmLabel: "Remove",
			variant: "danger"
		}) && await e.remove(t.map((e) => e.id));
	}, S = () => {
		l && e.rename(l.id, l.name), u(null);
	}, C = Vt(e.entries(), a), w = (e) => /* @__PURE__ */ q.createElement("div", {
		key: e.id,
		className: `${X.row}${n?.id === e.id ? ` ${X.current}` : ""}`,
		onMouseEnter: () => v(e),
		onContextMenu: (t) => {
			t.preventDefault(), v(null), f({
				x: t.clientX,
				y: t.clientY,
				entry: e
			});
		}
	}, l?.id === e.id ? /* @__PURE__ */ q.createElement("input", {
		className: X.rename,
		"aria-label": "LUT name",
		autoFocus: !0,
		value: l.name,
		onChange: (t) => u({
			id: e.id,
			name: t.target.value
		}),
		onBlur: S,
		onKeyDown: (e) => {
			e.key === "Enter" && S(), e.key === "Escape" && u(null);
		}
	}) : /* @__PURE__ */ q.createElement("button", {
		className: X.apply,
		title: e.folder ? `${e.folder}/${e.name}` : e.name,
		onClick: () => y(e)
	}, e.name), /* @__PURE__ */ q.createElement("button", {
		className: X.delete,
		title: "Remove from library",
		"aria-label": `Remove ${e.name}`,
		onClick: () => void x([e], `“${e.name}”`)
	}, "✕"));
	return /* @__PURE__ */ q.createElement("div", null, /* @__PURE__ */ q.createElement("div", { className: X.toolbar }, /* @__PURE__ */ q.createElement("button", {
		className: X.tool,
		disabled: p !== null,
		onClick: () => h.current?.click()
	}, "Add files…"), /* @__PURE__ */ q.createElement("button", {
		className: X.tool,
		disabled: p !== null,
		onClick: () => g.current?.click()
	}, "Add folder…")), p ? /* @__PURE__ */ q.createElement("p", {
		className: X.note,
		role: "status"
	}, p) : null, /* @__PURE__ */ q.createElement("input", {
		ref: h,
		type: "file",
		multiple: !0,
		accept: ".cube,.png,.tif,.tiff,.jpg,.jpeg",
		style: { display: "none" },
		onChange: (e) => void b(e.currentTarget)
	}), /* @__PURE__ */ q.createElement("input", {
		ref: g,
		type: "file",
		style: { display: "none" },
		onChange: (e) => void b(e.currentTarget)
	}), e.entries().length === 0 ? /* @__PURE__ */ q.createElement("p", { className: X.empty }, "The library is empty. Add .cube files or HaldCLUT images.") : /* @__PURE__ */ q.createElement(q.Fragment, null, /* @__PURE__ */ q.createElement("input", {
		className: X.search,
		type: "search",
		placeholder: "Search LUTs",
		"aria-label": "Search LUTs",
		value: a,
		onChange: (e) => o(e.target.value)
	}), /* @__PURE__ */ q.createElement("div", {
		className: X.sections,
		onMouseLeave: () => v(null)
	}, C.length === 0 ? /* @__PURE__ */ q.createElement("p", { className: X.empty }, "No LUT matches.") : null, C.map(({ folder: e, items: t }) => e === "" ? /* @__PURE__ */ q.createElement("div", {
		key: "",
		className: X.rows
	}, t.map(w)) : /* @__PURE__ */ q.createElement("div", { key: e }, /* @__PURE__ */ q.createElement("button", {
		className: X.groupHeader,
		onClick: () => c((t) => {
			let n = new Set(t);
			return n.has(e) ? n.delete(e) : n.add(e), n;
		}),
		onContextMenu: (t) => {
			t.preventDefault(), f({
				x: t.clientX,
				y: t.clientY,
				folder: e
			});
		}
	}, /* @__PURE__ */ q.createElement("span", { className: X.caret }, s.has(e) && !a ? "▸" : "▾"), /* @__PURE__ */ q.createElement("span", { className: X.groupName }, e), /* @__PURE__ */ q.createElement("span", { className: X.count }, t.length)), s.has(e) && !a ? null : /* @__PURE__ */ q.createElement("div", { className: X.rows }, t.map(w))))), /* @__PURE__ */ q.createElement(Gt, {
		count: e.entries().length,
		usage: e.usage()
	})), d ? /* @__PURE__ */ q.createElement(r, {
		x: d.x,
		y: d.y,
		onClose: () => f(null),
		items: d.entry ? [
			{
				label: "Rename…",
				onClick: () => d.entry && u({
					id: d.entry.id,
					name: d.entry.name
				})
			},
			"separator",
			{
				label: "Remove from library",
				danger: !0,
				onClick: () => d.entry && void x([d.entry], `“${d.entry.name}”`)
			}
		] : [{
			label: "Remove folder from library",
			danger: !0,
			onClick: () => {
				let t = e.entries().filter((e) => e.folder === d.folder);
				x(t, `${t.length} LUT${t.length === 1 ? "" : "s"} in “${d.folder}”`);
			}
		}]
	}) : null);
}
function Gt({ count: e, usage: t }) {
	let { ProgressBar: n, Stack: r } = J.ui, i = Math.min(100, Math.ceil(t * 100));
	return /* @__PURE__ */ q.createElement(r, { gap: 4 }, /* @__PURE__ */ q.createElement("p", {
		className: X.note,
		style: { marginTop: 6 }
	}, e, " LUT", e === 1 ? "" : "s", ", library ", i, "% full"), /* @__PURE__ */ q.createElement(n, { value: Math.min(1, t) }), t >= .9 ? /* @__PURE__ */ q.createElement("p", {
		className: X.warning,
		role: "status"
	}, t >= 1 ? "The library is full." : "The library is nearly full.", " Remove LUTs you no longer use to make room for more. A 33-point LUT takes about an eighth of the room of a 65-point one.") : null);
}
function Kt() {
	let { Select: e, Button: t, Stack: n, ProgressBar: r } = J.ui, i = J.catalog.useActivePhoto(), a = J.registry.use((e) => e.processingStages), [o, s] = q.useState("cube-33"), [c, l] = q.useState(null), [u, d] = q.useState(null), f = async () => {
		if (i) {
			d(null), l(0);
			try {
				let e = await At(J, i, Object.values(a), ke(o), l);
				Me(e.blob, e.fileName), d(e.leftOut.length > 0 ? `Saved ${e.fileName}. A LUT can only hold colour and tone, so it leaves out: ${e.leftOut.join(", ")}.` : `Saved ${e.fileName}.`);
			} catch (e) {
				d(`The look couldn't be exported: ${e instanceof Error ? e.message : String(e)}.`);
			} finally {
				l(null);
			}
		}
	};
	return /* @__PURE__ */ q.createElement(n, { gap: 6 }, /* @__PURE__ */ q.createElement(e, {
		ariaLabel: "LUT format",
		value: o,
		options: P.map((e) => ({
			value: e.id,
			label: e.label
		})),
		onChange: (e) => s(ke(e).id)
	}), /* @__PURE__ */ q.createElement(t, {
		size: "sm",
		variant: "secondary",
		full: !0,
		disabled: !i || c !== null,
		onClick: () => void f()
	}, "Export look as LUT…"), c === null ? null : /* @__PURE__ */ q.createElement(r, { value: c }), u ? /* @__PURE__ */ q.createElement("p", {
		className: X.note,
		role: "status"
	}, u) : /* @__PURE__ */ q.createElement("p", { className: X.note }, "Saves this photo's colour and tone as a LUT, sRGB in and out."));
}
function qt({ library: e }) {
	Lt(e);
	let { Section: t, Stack: n } = J.ui, r = J.develop.useParamScope(), i = He((e) => r.getParam(e)), a = Rt(i, e);
	return /* @__PURE__ */ q.createElement("div", { style: { padding: 8 } }, /* @__PURE__ */ q.createElement(n, { gap: 10 }, /* @__PURE__ */ q.createElement(Ut, {
		library: e,
		look: i,
		state: a
	}), /* @__PURE__ */ q.createElement(t, { title: "Library" }, /* @__PURE__ */ q.createElement(Wt, {
		library: e,
		look: i,
		current: a.kind === "applied" ? a.entry : null
	})), /* @__PURE__ */ q.createElement(t, { title: "Export" }, /* @__PURE__ */ q.createElement(Kt, null))));
}
//#endregion
//#region src/prepare.ts
async function Jt(e, t, n) {
	let r = await Dt(e, t, n);
	if (!r.ok) return r;
	let a = p(r.lut, i(r.hash));
	return {
		ok: !0,
		hash: r.hash,
		key: a.key,
		sig: a.sig,
		title: r.lut.title,
		format: r.format,
		layout: a.layout,
		texels: a.texels,
		notes: r.notes
	};
}
var Yt = 12, Xt = () => new Promise((e) => {
	let t = new MessageChannel();
	t.port1.onmessage = () => {
		t.port1.close(), e();
	}, t.port2.postMessage(null);
});
function Zt(e) {
	let t = performance.now();
	return async (n, r) => (performance.now() - t > Yt && (await Xt(), t = performance.now()), Jt(n, r, e));
}
function Qt(e, t) {
	let n = null, r = !1, i = 0, a = /* @__PURE__ */ new Map();
	function o() {
		r = !0, n?.terminate(), n = null;
		for (let e of a.values()) t(e.name, e.bytes).then(e.resolve, e.reject);
		a.clear();
	}
	function s() {
		if (n || r) return n;
		try {
			n = e();
		} catch {
			return r = !0, null;
		}
		return n.onmessage = (e) => {
			let t = a.get(e.data.id);
			t && (a.delete(e.data.id), t.resolve(e.data.result));
		}, n.onerror = o, n;
	}
	return Object.assign((e, n) => {
		let r = s();
		if (!r) return t(e, n);
		let o = i++, c = n.slice();
		return new Promise((t, i) => {
			a.set(o, {
				name: e,
				bytes: n,
				resolve: t,
				reject: i
			}), r.postMessage({
				id: o,
				name: e,
				bytes: c
			}, [c.buffer]);
		});
	}, { dispose: o });
}
//#endregion
//#region src/prepare-worker.ts?worker&inline
var $t = "(function(){function e(e){return parseInt(e.slice(0,8),16)&2147483647||1}function t(e){let t=new Uint8Array(new Float32Array(e).buffer),n=2166136261;for(let e of t)n=Math.imul(n^e,16777619);return n>>>0}function n(e){return t([e.kind,e.n3,e.n1,...e.lo3,...e.hi3,...e.lo1,...e.hi1,...e.range3,...e.range1])&2147483647}function r(e){let t=1/0,n=-1/0;for(let r of e.data)r<t&&(t=r),r>n&&(n=r);return n-t>1e-9?[t,n]:[t,t+1]}let i=(e,t)=>Math.min(65535,Math.max(0,Math.round((e-t[0])/(t[1]-t[0])*65535))),a=e=>e.kind&1?3*(e.n1-1):0,o=e=>e.kind&2?2*e.n3**3:0;function s(e,t){let s=[0,1],c={kind:+!!e.shaper|(e.cube?2:0),n3:e.cube?.size??2,n1:e.shaper?.size??2,lo3:e.cube?[...e.cube.lo]:[0,0,0],hi3:e.cube?[...e.cube.hi]:[1,1,1],lo1:e.shaper?[...e.shaper.lo]:[0,0,0],hi1:e.shaper?[...e.shaper.hi]:[1,1,1],range3:e.cube?r(e.cube):s,range1:e.shaper?r(e.shaper):s},l=new Uint8Array(4*(a(c)+o(c))),u=0;if(e.shaper){let t=c.n1,n=e.shaper.data;for(let e=0;e<3;e++)for(let r=0;r<t-1;r++){let t=i(n[3*r+e],c.range1),a=i(n[3*(r+1)+e],c.range1);l[u]=t>>8,l[u+1]=t&255,l[u+2]=a>>8,l[u+3]=a&255,u+=4}}if(e.cube){let t=e.cube.data;for(let e=0;e<t.length;e+=3){for(let n=0;n<3;n++){let r=i(t[e+n],c.range3);l[u+n]=r>>8,l[u+4+n]=r&255}u+=8}}return{key:t,layout:c,sig:n(c),texels:l}}let c=(e,t,n)=>e<t?t:e>n?n:e;function l(e){let[t,n,r]=e;return t>=n?n>=r?[0,1,2]:t>=r?[0,2,1]:[2,0,1]:r>=n?[2,1,0]:r>=t?[1,2,0]:[1,0,2]}function u(e,t,n,r=1){let i=t-1,a=[0,0,0],o=[0,0,0],s=[0,0,0];for(let e=0;e<3;e++){s[e]=c(n[e],0,1);let r=s[e]*i;a[e]=Math.min(Math.floor(r),t-2),o[e]=r-a[e]}let u=l(o),d=[a[0],a[1],a[2]],f=e=>3*(e[0]+t*(e[1]+t*e[2])),p=f(d),m=[e[p],e[p+1],e[p+2]],h=Array(9).fill(0);for(let t of u){d[t]+=1;let n=f(d);for(let r=0;r<3;r++){let a=e[n+r]-e[p+r];m[r]+=o[t]*a,h[3*t+r]=a*i}p=n}for(let e=0;e<3;e++){let t=n[e]-s[e];if(t!==0)for(let n=0;n<3;n++)m[n]+=h[3*e+n]*t}if(r!==1){for(let e=0;e<3;e++)m[e]/=r;for(let e=0;e<9;e++)h[e]/=r}return{value:m,jac:h}}function d(e,t){let n=[0,0,0];for(let r=0;r<3;r++)n[r]=(t[r]-e.lo[r])/(e.hi[r]-e.lo[r]);return u(e.data,e.size,n).value}function f(e,t,n=[0,0,0],r=[1,1,1]){let i=new Float64Array(e*e*e*3),a=(t,i)=>n[t]+(r[t]-n[t])*i/(e-1),o=0;for(let n=0;n<e;n++)for(let r=0;r<e;r++)for(let s=0;s<e;s++){let e=t(a(0,s),a(1,r),a(2,n));i[o++]=e[0],i[o++]=e[1],i[o++]=e[2]}return{size:e,lo:[...n],hi:[...r],data:i}}function p(e,t){return e.size===t?e:f(t,(t,n,r)=>d(e,[t,n,r]),e.lo,e.hi)}let m=e=>({ok:!1,error:e});function h(e,t,n){if(e.length!==3)return`${n} on line ${t} needs three numbers`;let r=e.map(Number);return r.every(Number.isFinite)?[r[0],r[1],r[2]]:`${n} on line ${t} isn't three numbers`}function g(e,t,n){if(e.length!==2)return`${n} on line ${t} needs two numbers`;let r=e.map(Number);return r.every(Number.isFinite)?r[0]<r[1]?[r[0],r[1]]:`${n} on line ${t} must run from a lower to a higher value`:`${n} on line ${t} isn't two numbers`}function _(e,t,n,r){let i=e.length===1?Number(e[0]):NaN;return!Number.isInteger(i)||i<2||i>r?`${n} on line ${t} must be a whole number from 2 to ${r}`:i}function v(e,t){let n=e.length,r=0,i=0;for(let a=0;a<n;a++)r+=e[a],i+=t[a];r/=n,i/=n;let a=0,o=0,s=0;for(let c=0;c<n;c++){let n=e[c]-r,l=t[c]-i;a+=n*l,o+=n*n,s+=l*l}return o>0&&s>0?a/Math.sqrt(o*s):0}function y(e,t){if(t<3)return!1;let n=t*t*t,r=new Float64Array(n),i=new Float64Array(n),a=new Float64Array(n),o=new Float64Array(n);for(let s=0;s<n;s++)r[s]=s%t,i[s]=Math.floor(s/(t*t)),a[s]=e[3*s],o[s]=e[3*s+2];let s=v(a,r)+v(o,i);return v(a,i)+v(o,r)>s+.5}function b(e,t){let n=new Float64Array(e.length);for(let r=0;r<t;r++)for(let i=0;i<t;i++)for(let a=0;a<t;a++){let o=3*(r+t*(i+t*a)),s=3*(a+t*(i+t*r));n[s]=e[o],n[s+1]=e[o+1],n[s+2]=e[o+2]}return n}function x(e,t){let n=null,r=null,i=null,a=null,o=null,s=null,c=null,l=/* @__PURE__ */ new Set,u=/* @__PURE__ */ new Float64Array,d=0,f=!1,p=e.replace(/^﻿/,``).split(/\\r\\n|\\r|\\n/);for(let e=0;e<p.length;e++){let t=e+1,v=p[e].trim();if(v.startsWith(`TITLE`)){if(f)return m(`TITLE on line ${t} comes after the table data`);if(l.has(`TITLE`))return m(`TITLE is given twice (line ${t})`);l.add(`TITLE`);let e=v.slice(5).trim(),r=/^\"([^\"]*)\"/.exec(e);n=(r?r[1]:e.split(`#`)[0]).trim();continue}let y=v.indexOf(`#`);if(y>=0&&(v=v.slice(0,y).trim()),v===``)continue;let b=v.split(/\\s+/),x=b[0];if(/^[-+.\\d]/.test(x)){if(!f){if(f=!0,r===null&&i===null)return m(`Table data starts on line ${t} before LUT_1D_SIZE or LUT_3D_SIZE`);u=new Float64Array(3*((r??0)+(i??0)**3))}let e=h(b,t,`The table entry`);if(typeof e==`string`)return m(e);if(d+3>u.length)return m(`The table has more entries than its size calls for (line ${t})`);u[d++]=e[0],u[d++]=e[1],u[d++]=e[2];continue}if(!/^[A-Z][A-Z0-9_]*$/.test(x))return m(`Line ${t} isn't a keyword or a table entry: \"${v.slice(0,40)}\"`);if(f)return m(`${x} on line ${t} comes after the table data`);if(l.has(x))return m(`${x} is given twice (line ${t})`);l.add(x);let S=b.slice(1);switch(x){case`LUT_1D_SIZE`:{let e=_(S,t,x,65536);if(typeof e==`string`)return m(e);r=e;break}case`LUT_3D_SIZE`:{let e=_(S,t,x,256);if(typeof e==`string`)return m(e);i=e;break}case`DOMAIN_MIN`:case`DOMAIN_MAX`:{let e=h(S,t,x);if(typeof e==`string`)return m(e);x===`DOMAIN_MIN`?a=e:o=e;break}case`LUT_1D_INPUT_RANGE`:case`LUT_3D_INPUT_RANGE`:{let e=g(S,t,x);if(typeof e==`string`)return m(e);x===`LUT_1D_INPUT_RANGE`?s=e:c=e;break}case`LUT_IN_VIDEO_RANGE`:case`LUT_OUT_VIDEO_RANGE`:return m(`${x} (line ${t}): video-range LUTs aren't supported`)}}if(r===null&&i===null)return m(`The file names no LUT_1D_SIZE or LUT_3D_SIZE`);if(s&&r===null)return m(`LUT_1D_INPUT_RANGE is given without a 1D table`);if(c&&i===null)return m(`LUT_3D_INPUT_RANGE is given without a 3D table`);let v=a??[0,0,0],x=o??[1,1,1];for(let e=0;e<3;e++)if(!(v[e]<x[e]))return m(`DOMAIN_MIN must be below DOMAIN_MAX in every channel`);let S=(r??0)+(i??0)**3,C=d/3;if(C!==S)return m(`The table has ${C} entries where its size${r&&i?`s call`:` calls`} for ${S}`);let w=(e,t,n,r)=>({size:e,lo:r?[r[0],r[0],r[0]]:[...v],hi:r?[r[1],r[1],r[1]]:[...x],data:u.slice(3*t,3*(t+n))}),T=r===null?null:w(r,0,r,s),E=i===null?null:w(i,r??0,i**3,c),D=`red-fastest`;return E&&y(E.data,E.size)&&(E={...E,data:b(E.data,E.size)},D=`blue-fastest`),{ok:!0,lut:{title:n||t,shaper:T,cube:E},axisOrder:D}}function S(e,t){if(e!==t)return null;for(let t=2;t<=16;t++)if(t**3===e)return t;return null}function C(e,t){let n=e.width*e.height,r=(e,n)=>Math.floor(e/t**n)%t,i=0;for(let t=0;t<3;t++)for(let a=0;a<3;a++){let o=0,s=0,c=0,l=0,u=0;for(let i=0;i<n;i++){let n=r(i,t),d=e.data[3*i+a];o+=n,s+=d,c+=n*n,l+=d*d,u+=n*d}let d=c-o*o/n,f=l-s*s/n;d>0&&f>0&&(i=Math.max(i,Math.abs((u-o*s/n)/Math.sqrt(d*f))))}return i}function w(e,t){let n=S(e.width,e.height);if(n===null)return{ok:!1,error:`A ${e.width} × ${e.height} image isn't a HaldCLUT: it must be square, 8 to 4096 pixels a side, a whole number cubed`};let r=n*n;for(let t=0;t<e.data.length;t++)if(!Number.isFinite(e.data[t]))return{ok:!1,error:`The image has pixels that aren't numbers`};if(C(e,r)<.3)return{ok:!1,error:`The image is the size of a HaldCLUT, but its pixels don't follow a HaldCLUT's colour grid`};let i;if(r<=65){let t=new Float64Array(e.data.length);for(let n=0;n<t.length;n++)t[n]=e.data[n]/e.scale;i={size:r,lo:[0,0,0],hi:[1,1,1],data:t}}else i=f(65,(t,n,i)=>u(e.data,r,[t,n,i],e.scale).value);return{ok:!0,lut:{title:t,shaper:null,cube:i},level:n}}async function T(e,t){let n=t.writable.getWriter(),r=n.write(e).then(()=>n.close()),i=t.readable.getReader(),a=[],o=0;for(;;){let{done:e,value:t}=await i.read();if(e)break;a.push(t),o+=t.length}await r;let s=new Uint8Array(o),c=0;for(let e of a)s.set(e,c),c+=e.length;return s}let E=e=>T(e,new DecompressionStream(`deflate`)),D=null;function O(e,t=0,n=e.length){if(!D){D=/* @__PURE__ */ new Uint32Array(256);for(let e=0;e<256;e++){let t=e;for(let e=0;e<8;e++)t=t&1?3988292384^t>>>1:t>>>1;D[e]=t>>>0}}let r=4294967295;for(let i=t;i<n;i++)r=D[(r^e[i])&255]^r>>>8;return(r^4294967295)>>>0}let k=[137,80,78,71,13,10,26,10],A={0:1,2:3,3:1,4:2,6:4},j=(e,t)=>(e[t]<<24|e[t+1]<<16|e[t+2]<<8|e[t+3])>>>0;function M(e,t,n){let r=e+t-n,i=Math.abs(r-e),a=Math.abs(r-t),o=Math.abs(r-n);return i<=a&&i<=o?e:a<=o?t:n}function N(e,t,n,r){let i=new Uint8Array(t*n);for(let a=0;a<t;a++){let t=e[a*(n+1)],o=a*(n+1)+1,s=a*n,c=s-n;for(let l=0;l<n;l++){let n=e[o+l],u=l>=r?i[s+l-r]:0,d=a>0?i[c+l]:0,f=l>=r&&a>0?i[c+l-r]:0;switch(t){case 0:i[s+l]=n;break;case 1:i[s+l]=n+u;break;case 2:i[s+l]=n+d;break;case 3:i[s+l]=n+(u+d>>1);break;case 4:i[s+l]=n+M(u,d,f);break;default:throw Error(`row ${a+1} has an unknown filter (${t})`)}}}return i}function P(e){return k.every((t,n)=>e[n]===t)}async function F(e){if(!P(e))throw Error(`it isn't a PNG file`);let t=8,n=0,r=0,i=0,a=-1,o=null,s=[],c=!1;for(;t+12<=e.length;){let l=j(e,t),u=String.fromCharCode(e[t+4],e[t+5],e[t+6],e[t+7]),d=t+8,f=d+l;if(f+4>e.length)throw Error(`the ${u} chunk is cut short`);if(O(e,t+4,f)!==j(e,f))throw Error(`the ${u} chunk is damaged (checksum)`);let p=e.subarray(d,f);if(u===`IHDR`){if(n=j(p,0),r=j(p,4),i=p[8],a=p[9],p[10]!==0||p[11]!==0)throw Error(`it uses an unknown compression or filter method`);if(p[12]!==0)throw Error(`interlaced PNGs aren't supported; save it without interlacing`)}else if(u===`PLTE`)o=p.slice();else if(u===`IDAT`)s.push(p);else if(u===`IEND`){c=!0;break}else if(u.charCodeAt(0)<97)throw Error(`it has a chunk this reader doesn't know (${u})`);t=f+4}if(!c)throw Error(`the file is cut short`);if(n===0||r===0)throw Error(`it has no image header`);let l=A[a];if(l===void 0)throw Error(`it has an unknown colour type (${a})`);if(a===0||a===4)throw Error(`it is greyscale: a HaldCLUT needs colour`);if(a===3?i!==8:i!==8&&i!==16)throw Error(`${i}-bit samples of this colour type aren't supported`);if(a===3&&!o)throw Error(`its palette is missing`);let u=s.reduce((e,t)=>e+t.length,0),d=new Uint8Array(u),f=0;for(let e of s)d.set(e,f),f+=e.length;let p;try{p=await E(d)}catch{throw Error(`its image data is damaged`)}let m=i/8*l,h=n*m;if(p.length<r*(h+1))throw Error(`its image data is cut short`);let g=N(p,r,h,m),_=n*r;if(i===16){let e=new Uint16Array(_*3);for(let t=0;t<_;t++){let n=t*m;for(let r=0;r<3;r++)e[3*t+r]=g[n+2*r]<<8|g[n+2*r+1]}return{width:n,height:r,data:e,scale:65535}}let v=new Uint8Array(_*3);for(let e=0;e<_;e++)if(o){let t=g[e]*3;if(t+3>o.length)throw Error(`a pixel names a colour the palette doesn't have`);v.set(o.subarray(t,t+3),3*e)}else{let t=e*m;v[3*e]=g[t],v[3*e+1]=g[t+1],v[3*e+2]=g[t+2]}return{width:n,height:r,data:v,scale:255}}let I={width:256,height:257,bits:258,compression:259,photometric:262,stripOffsets:273,samples:277,rowsPerStrip:278,stripBytes:279,planar:284,predictor:317,tileWidth:322,sampleFormat:339},L={1:1,2:1,3:2,4:4,5:8,6:1,7:1,8:2,9:4,10:8,11:4,12:8};function R(e){return e[0]===73&&e[1]===73&&e[2]===42&&e[3]===0||e[0]===77&&e[1]===77&&e[2]===0&&e[3]===42}function z(e,t){let n=/* @__PURE__ */ new Int32Array(4096),r=/* @__PURE__ */ new Uint8Array(4096),i=/* @__PURE__ */ new Uint16Array(4096),a=/* @__PURE__ */ new Uint8Array(4096);for(let e=0;e<256;e++)n[e]=-1,r[e]=e,i[e]=1,a[e]=e;let o=new Uint8Array(Math.max(t,1)),s=0,c=0,l=9,u=258,d=-1,f=e.length*8,p=()=>{if(c+l>f)return 257;let t=0;for(let n=0;n<l;n++){let r=c+n;t=t<<1|e[r>>3]>>7-(r&7)&1}return c+=l,t},m=e=>{let t=i[e];if(s+t>o.length){let e=new Uint8Array(Math.max(o.length*2,s+t));e.set(o),o=e}let a=e;for(let e=t-1;e>=0;e--)o[s+e]=r[a],a=n[a];s+=t},h=(e,t)=>{u>=4096||(n[u]=e,r[u]=t,i[u]=i[e]+1,a[u]=a[e],u++,u===(1<<l)-1&&l<12&&l++)};for(;;){let e=p();if(e===257)break;if(e===256)u=258,l=9,d=-1;else{if(d===-1){if(e>255)throw Error(`its LZW data is damaged`);m(e)}else if(e<u)m(e),h(d,a[e]);else if(e===u)h(d,a[d]),m(e);else throw Error(`its LZW data is damaged`);d=e}}return o.subarray(0,s)}function B(e,t){let n=new Uint8Array(t),r=0,i=0;for(;i<e.length&&r<t;){let a=e[i++]<<24>>24;if(a>=0)for(let o=0;o<=a&&r<t;o++)n[r++]=e[i++];else if(a!==-128){let o=e[i++];for(let e=0;e<1-a&&r<t;e++)n[r++]=o}}return n}async function V(e){if(!R(e))throw Error(`it isn't a TIFF file`);let t=new DataView(e.buffer,e.byteOffset,e.byteLength),n=e[0]===73,r=e=>t.getUint16(e,n),i=e=>t.getUint32(e,n),a=i(4);if(a+2>e.length)throw Error(`the file is cut short`);let o=r(a),s=/* @__PURE__ */ new Map;for(let t=0;t<o;t++){let n=a+2+12*t;if(n+12>e.length)throw Error(`the file is cut short`);let o=r(n),c=r(n+2),l=i(n+4),u=L[c]??0;if(c!==3&&c!==4)continue;let d=u*l<=4?n+8:i(n+8);if(d+u*l>e.length)throw Error(`the file is cut short`);let f=[];for(let e=0;e<l;e++)f.push(c===3?r(d+2*e):i(d+4*e));s.set(o,f)}let c=(e,t)=>{let n=s.get(e)?.[0]??t;if(n===void 0)throw Error(`it lacks a required field (tag ${e})`);return n},l=c(I.width),u=c(I.height),d=c(I.samples,1),f=s.get(I.bits)??[1],p=f[0],m=c(I.compression,1),h=c(I.predictor,1),g=c(I.sampleFormat,1);if(s.has(I.tileWidth))throw Error(`tiled TIFFs aren't supported; save it in strips`);if(c(I.planar,1)!==1)throw Error(`TIFFs with separate colour planes aren't supported`);if(c(I.photometric,2)!==2||d<3)throw Error(`it isn't an RGB image`);if(f.some(e=>e!==p))throw Error(`its channels have different bit depths`);let _=g===3&&p===32?`float`:g===1&&(p===8||p===16)?`uint`:null;if(!_)throw Error(`${p}-bit ${g===3?`floating-point`:`integer`} samples aren't supported`);if(h!==1&&(h!==2||_!==`uint`))throw Error(`its predictor isn't supported`);let v=s.get(I.stripOffsets),y=s.get(I.stripBytes);if(!v||!y||v.length!==y.length)throw Error(`its strips are missing`);let b=Math.min(c(I.rowsPerStrip,u),u),x=p/8,S=l*d*x,C=new Uint8Array(S*u);for(let t=0;t<v.length;t++){let n=Math.min(b,u-t*b);if(n<=0)break;let r=n*S;if(v[t]+y[t]>e.length)throw Error(`a strip runs past the end of the file`);let i=e.subarray(v[t],v[t]+y[t]),a;if(m===1)a=i;else if(m===5)a=z(i,r);else if(m===8||m===32946)try{a=await E(i)}catch{throw Error(`its Deflate data is damaged`)}else if(m===32773)a=B(i,r);else throw Error(`its compression (${m}) isn't supported`);if(a.length<r)throw Error(`a strip is cut short`);C.set(a.subarray(0,r),t*b*S)}let w=l*u,T=new DataView(C.buffer);if(_===`float`){let e=new Float32Array(w*3);for(let t=0;t<w;t++)for(let r=0;r<3;r++)e[3*t+r]=T.getFloat32((t*d+r)*4,n);return{width:l,height:u,data:e,scale:1}}let D=p===16?new Uint16Array(w*d):C;if(p===16)for(let e=0;e<D.length;e++)D[e]=T.getUint16(2*e,n);if(h===2){let e=p===16?65535:255;for(let t=0;t<u;t++)for(let n=1;n<l;n++)for(let r=0;r<d;r++){let i=(t*l+n)*d+r;D[i]=D[i]+D[i-d]&e}}let O=p===16?new Uint16Array(w*3):new Uint8Array(w*3);for(let e=0;e<w;e++)for(let t=0;t<3;t++)O[3*e+t]=D[e*d+t];return{width:l,height:u,data:O,scale:p===16?65535:255}}let H=e=>e[0]===255&&e[1]===216&&e[2]===255;function U(e){let t=e.split(/[\\\\/]/).pop()??e,n=t.lastIndexOf(`.`);return n>0?t.slice(0,n):t}async function W(e){let t=await crypto.subtle.digest(`SHA-256`,e);return[...new Uint8Array(t)].map(e=>e.toString(16).padStart(2,`0`)).join(``)}function G(e){return e===null||e.data.every(Number.isFinite)}async function K(e,t,n){let r=U(e),i=[],a,o;if(e.toLowerCase().endsWith(`.cube`)){let e;try{e=new TextDecoder(`utf-8`,{fatal:!0}).decode(t)}catch{return{ok:!1,error:`The file isn't text, so it can't be a .cube LUT`}}let n=x(e,r);if(!n.ok)return n;a=n.lut,o=`cube`,n.axisOrder===`blue-fastest`&&i.push(`Its entries run blue fastest; read in that order.`)}else{let e;try{if(P(t))e=await F(t);else if(R(t))e=await V(t);else if(H(t))e=await n(t);else return{ok:!1,error:`The file isn't a .cube LUT or a PNG, TIFF or JPEG HaldCLUT`}}catch(e){return{ok:!1,error:`The image can't be read: ${e instanceof Error?e.message:String(e)}`}}let s=w(e,r);if(!s.ok)return s;a=s.lut,o=`hald`,s.level*s.level>65&&i.push(`Level ${s.level} is resampled to 65 nodes an axis.`)}return!G(a.shaper)||!G(a.cube)?{ok:!1,error:`The table holds values that aren't numbers`}:(a.cube&&a.cube.size>65&&(i.push(`Its ${a.cube.size}-node table is resampled to 65 nodes an axis.`),a={...a,cube:p(a.cube,65)}),{ok:!0,lut:a,format:o,hash:await W(t),notes:i})}let q=async e=>{let t=await createImageBitmap(new Blob([e],{type:`image/jpeg`}),{colorSpaceConversion:`none`,premultiplyAlpha:`none`}),n=new OffscreenCanvas(t.width,t.height),r=n.getContext(`2d`);if(!r)throw Error(`no canvas to decode it on`);r.drawImage(t,0,0);let i=r.getImageData(0,0,t.width,t.height).data,a=new Uint8Array(t.width*t.height*3);for(let e=0;e<a.length/3;e++)a[3*e]=i[4*e],a[3*e+1]=i[4*e+1],a[3*e+2]=i[4*e+2];return t.close(),{width:n.width,height:n.height,data:a,scale:255}};async function J(t,n,r){let i=await K(t,n,r);if(!i.ok)return i;let a=s(i.lut,e(i.hash));return{ok:!0,hash:i.hash,key:a.key,sig:a.sig,title:i.lut.title,format:i.format,layout:a.layout,texels:a.texels,notes:i.notes}}self.addEventListener(`message`,e=>{let{id:t,name:n,bytes:r}=e.data;J(n,r,q).catch(e=>({ok:!1,error:`The file can't be read: ${e instanceof Error?e.message:String(e)}`})).then(e=>{let n={id:t,result:e};self.postMessage(n,{transfer:e.ok?[e.texels.buffer]:[]})})})})();\n//# sourceMappingURL=prepare-worker-DjzG6Itx.js.map", en = typeof self < "u" && self.Blob && new Blob(["(self.URL || self.webkitURL).revokeObjectURL(self.location.href);", $t], { type: "text/javascript;charset=utf-8" });
function tn(e) {
	let t;
	try {
		if (t = en && (self.URL || self.webkitURL).createObjectURL(en), !t) throw "";
		let n = new Worker(t, { name: e?.name });
		return n.addEventListener("error", () => {
			(self.URL || self.webkitURL).revokeObjectURL(t);
		}), n;
	} catch {
		return new Worker("data:text/javascript;charset=utf-8," + encodeURIComponent($t), { name: e?.name });
	}
}
//#endregion
//#region src/store.ts
var nn = "lut-tools", Z = "luts";
function rn(e) {
	return new Promise((t, n) => {
		e.onsuccess = () => t(e.result), e.onerror = () => n(e.error ?? /* @__PURE__ */ Error("IndexedDB request failed"));
	});
}
function an(e) {
	return new Promise((t, n) => {
		e.oncomplete = () => t(), e.onerror = () => n(e.error ?? /* @__PURE__ */ Error("IndexedDB transaction failed")), e.onabort = () => n(e.error ?? /* @__PURE__ */ Error("IndexedDB transaction aborted"));
	});
}
function on() {
	let e = null, t = () => (e ??= new Promise((e, t) => {
		let n = indexedDB.open(nn, 1);
		n.onupgradeneeded = () => {
			n.result.objectStoreNames.contains(Z) || n.result.createObjectStore(Z, { keyPath: "id" });
		}, n.onsuccess = () => e(n.result), n.onerror = () => t(n.error ?? /* @__PURE__ */ Error("the LUT library can't be opened"));
	}), e);
	return {
		async all() {
			return rn((await t()).transaction(Z, "readonly").objectStore(Z).getAll());
		},
		async put(e) {
			let n = (await t()).transaction(Z, "readwrite");
			n.objectStore(Z).put(e), await an(n);
		},
		async delete(e) {
			let n = (await t()).transaction(Z, "readwrite");
			n.objectStore(Z).delete(e), await an(n);
		}
	};
}
function sn(e = []) {
	let t = new Map(e.map((e) => [e.id, e]));
	return {
		all: async () => [...t.values()],
		put: async (e) => void t.set(e.id, e),
		delete: async (e) => void t.delete(e)
	};
}
//#endregion
//#region src/index.tsx
var cn = `${F}.panel`, ln = `${F}.styles`, Q = null, $ = null, un = () => Q;
function dn() {
	let e = J.stores.useDevelopStore.getState();
	e.setDynParams(ze()), e.commitEdit("LUT reset");
}
function fn(e) {
	jt(e), Q?.dispose(), $?.(), e.registerProcessingStage(Ke()), e.registerProcessingStage(Ye()), e.registerStylesheet({
		id: ln,
		css: It(e.ui.tokens)
	});
	let t = Qt(() => new tn({ name: "LUT import" }), Zt(Ot));
	$ = t.dispose;
	let n = w({
		store: typeof indexedDB > "u" ? sn() : on(),
		setPage: (t, n) => e.setStageTexture(I, B, n, o(t)),
		prepare: t,
		channel: T(`${F}.library`)
	});
	Q = n, n.reload().catch((e) => console.error("[lut-tools] the LUT library couldn't be read:", e)), e.registerPanel({
		id: cn,
		title: "LUT",
		component: () => /* @__PURE__ */ q.createElement(qt, { library: n }),
		defaultDock: {
			module: "develop",
			direction: "right"
		},
		onReset: dn
	});
}
function pn() {
	Q && (Q.dispose(), Q = null, $?.(), $ = null, J.develop.setViewValues(null), J.unregisterProcessingStage(I), J.unregisterProcessingStage(L));
}
//#endregion
export { cn as PANEL_ID, ln as STYLESHEET_ID, fn as activate, un as activeLibrary, pn as deactivate };

//# sourceMappingURL=index.js.map