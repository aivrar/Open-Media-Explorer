(function() {
	function Ua(lr) {
		return (function(ha) {
			function ma() {
				"use strict";
				var s = {
					width: 0,
					height: 0,
					resetKey: "",
					generation: 0,
					frameCount: 0,
					resetCount: 0,
					r: null,
					g: null,
					b: null,
					maxPixels: 1048576
				}, Ma = 50, $ = 46, ua = [
					0,
					1,
					2,
					3,
					4,
					5,
					6,
					7,
					8,
					9,
					10,
					11,
					12,
					13,
					24,
					21,
					15,
					20,
					25,
					23,
					27,
					26,
					18,
					22,
					0,
					14,
					19,
					2,
					21,
					9,
					20,
					23,
					28,
					29,
					30,
					31,
					32,
					33,
					34,
					35,
					36,
					37,
					38,
					39,
					40,
					41,
					42,
					43,
					44,
					45
				], Sa = [
					14,
					7,
					1,
					16,
					2,
					1,
					11,
					21,
					23,
					6,
					2,
					2,
					2,
					7,
					14,
					2,
					14,
					1,
					2,
					7,
					14,
					14,
					16,
					17,
					8,
					2,
					1,
					2,
					7,
					21,
					15,
					8,
					2,
					14,
					14,
					0,
					7,
					2,
					2,
					2,
					2,
					2,
					2,
					2,
					2,
					2,
					14,
					7,
					2,
					14
				];
				function z(r, e) {
					return r = Number(r), isFinite(r) ? r : e;
				}
				function j(r) {
					return z(r && r.time, s.frameCount / 60);
				}
				function o(r, e, t) {
					return r = z(r, e), Math.max(e, Math.min(t, r));
				}
				function wa(r) {
					return Math.sin(r * 127.1 + 311.7) * 43758.5453123 % 1;
				}
				function V(r) {
					return r - Math.floor(r);
				}
				function za(r, e, t, i) {
					if (r = Math.max(1, Math.floor(z(r, 1))), e = Math.max(1, Math.floor(z(e, 1))), r * e > s.maxPixels) {
						var a = Math.sqrt(s.maxPixels / (r * e));
						r = Math.max(1, Math.floor(r * a)), e = Math.max(1, Math.floor(e * a));
					}
					s.width = r, s.height = e, s.resetKey = String(t || ""), s.generation = i || 0, s.frameCount = 0, s.resetCount++, s.r = new Float32Array(r * e), s.g = new Float32Array(r * e), s.b = new Float32Array(r * e);
				}
				function Za(r) {
					var e = Math.max(1, Math.floor(z(r.width, 1))), t = Math.max(1, Math.floor(z(r.height, 1))), i = String(r.resetKey || ""), a = Math.floor(z(r.generation, 0));
					(!s.r || s.width !== e || s.height !== t || s.resetKey !== i || s.generation !== a) && za(e, t, i, a);
				}
				function ka(r) {
					if (r = o(r, 0, 1), !(r >= .9999)) for (var e = s.r, t = s.g, i = s.b, a = 0; a < e.length; a++) e[a] *= r, t[a] *= r, i[a] *= r;
				}
				function d(r, e, t, i, a, h) {
					if (!(r < 0 || e < 0 || r >= 1 || e >= 1)) {
						var n = Math.floor(r * s.width), M = Math.floor(e * s.height);
						if (!(n < 0 || M < 0 || n >= s.width || M >= s.height)) {
							var v = M * s.width + n;
							s.r[v] += t * h, s.g[v] += i * h, s.b[v] += a * h;
						}
					}
				}
				function va(r, e, t, i, a, h, n) {
					d((r - t.xMin) / Math.max(t.xMax - t.xMin, 1e-6), 1 - (e - t.yMin) / Math.max(t.yMax - t.yMin, 1e-6), i, a, h, n);
				}
				function Ea(r) {
					for (var e = r.params || {}, t = Math.floor(o(r.batchSize, 1, 2e5)), i = z(e.seed, .137), a = z(e.phase, 0), h = o(e.turns, 1, 18), n = o(e.radius, .05, .95), M = o(e.jitter, 0, .2), v = s.frameCount * t, f = 0; f < t; f++) {
						var m = v + f, u = V((m + .5) * .61803398875 + i), c = u * 6.28318530718 * h + a + s.frameCount * .035, x = n * Math.sqrt(u), w = Math.sin(u * 41 + a) * M, l = .5 + Math.cos(c) * (x + w), y = .5 + Math.sin(c) * (x + w), S = V(u + i + Math.sin(c * .37) * .08);
						d(l, y, .65 + .35 * Math.sin(S * 6.28318), .62 + .38 * Math.sin((S + .33) * 6.28318), .62 + .38 * Math.sin((S + .66) * 6.28318), 1);
						var C = V(Math.abs(wa(m + i * 1e3))) * 6.28318530718 + a * .7, F = n * (.12 + .78 * V(u * 3.7));
						d(.5 + Math.cos(C) * F, .5 + Math.sin(C * 1.31) * F * .72, .45, .7, 1, .38);
					}
					return s.frameCount++, t;
				}
				function Ra(r) {
					var e = z(r.xMin, -2.25), t = z(r.xMax, 1.15), i = z(r.yMin, -1.45), a = z(r.yMax, 1.45);
					if (e > t) {
						var h = e;
						e = t, t = h;
					}
					if (i > a) {
						var n = i;
						i = a, a = n;
					}
					return Math.abs(t - e) < 1e-4 && (e -= .5, t += .5), Math.abs(a - i) < 1e-4 && (i -= .5, a += .5), {
						xMin: e,
						xMax: t,
						yMin: i,
						yMax: a
					};
				}
				function Wa(r, e) {
					var t = Ra(r), i = (t.xMin + t.xMax) * .5, a = (t.yMin + t.yMax) * .5, h = (t.xMax - t.xMin) * .5 * o(r.sampleScale, .35, 3.5), n = (t.yMax - t.yMin) * .5 * o(r.sampleScale, .35, 3.5), M = o(r.windowDrift, 0, 1.5), v = o(r.driftSpeed, -6, 6), f = o(r.windowZoomSpeed, -6, 6);
					i += Math.sin(e * v * .82 + z(r.seed, 0) * 4) * h * M * .18, a += Math.cos(e * v * .68 - z(r.seed, 0) * 3) * n * M * .18;
					var m = Math.exp(Math.sin(e * f * .7) * .22);
					h *= m, n *= m;
					var u = o(r.globalZoom, .05, 1);
					return h /= u, n /= u, {
						xMin: i - h,
						xMax: i + h,
						yMin: a - n,
						yMax: a + n
					};
				}
				function Xa(r, e, t, i, a, h, n) {
					var M = o(n.channelGain, .1, 4), v = o(n.slowBucket, 16, 800), f = o(n.midBucket, 8, 700), m = e / Math.max(t, 1);
					r === 2 ? va(i, a, h, e >= v ? M : .04, e >= f ? .78 * M : .1, .76 + .24 * (1 - m), .85) : r === 1 ? va(i, a, h, 1 * M, .44 + .22 * m, .88, .72) : va(i, a, h, .48 + .22 * m, .68 + .3 * m, 1 * M, .78);
				}
				function Ya(r) {
					var e = r.params || {}, t = Math.max(0, Math.min(2, Math.round(z(e.mode, 0)))), i = Math.floor(o(r.batchSize, 1, 6e4)), a = Math.floor(o(e.minIter, 1, 400)), h = Math.floor(o(e.maxIter, Math.max(a + 4, 12), 520));
					h <= a && (h = a + 4);
					for (var n = z(e.seed, .413), M = o(e.sampleMotion, 0, 2), v = j(r), f = Wa(e, v), m = new Float32Array(h), u = new Float32Array(h), c = s.frameCount * i, x = i, w = 0; w < i; w++) {
						if ((w & 255) === 255 && Date.now() > s.deadline) {
							x = w + 1;
							break;
						}
						for (var l = c + w, y = V((l + .5) * .754877666 + n + v * .01 * M + s.frameCount * 11e-5 * M), S = V((l + .5) * .569840291 + n * 1.731 + Math.sin(v * .9 + s.frameCount * .01) * .025 * M), C = f.xMin + y * (f.xMax - f.xMin), F = f.yMin + S * (f.yMax - f.yMin), D = 0, b = 0, P = !1, p = 0, O = 0; O < h; O++) {
							var _ = D * D - b * b + C, T = 2 * D * b + F;
							if (D = _, b = T, m[O] = D, u[O] = b, p = O + 1, D * D + b * b > 4) {
								P = !0;
								break;
							}
						}
						if (t === 1) {
							if (P || p < a) continue;
						} else if (!P || p < a) continue;
						for (var A = Math.max(1, Math.floor(p / 190)), I = 0; I < p; I += A) Xa(t, p, h, m[I], u[I], f, e);
					}
					return s.frameCount++, x;
				}
				function K(r) {
					return V(Math.abs(wa(r)));
				}
				function Ca(r) {
					var e = 6.28318530718;
					return r - e * Math.floor(r / e + .5);
				}
				function R(r) {
					return isFinite(r.x) && isFinite(r.y) && isFinite(r.z) && Math.abs(r.x) < 1e6 && Math.abs(r.y) < 1e6 && Math.abs(r.z) < 1e6;
				}
				function Ha(r) {
					return r >= 10 && r <= 15;
				}
				function Fa(r) {
					var e, t, i = .005, a = 4, h = .45, n = 140;
					return r === 0 ? (e = [
						10,
						28,
						2.6666667,
						0,
						0,
						0
					], t = [
						2,
						8,
						.8,
						1,
						1,
						1
					], i = .0045, a = 34) : r === 1 ? (e = [
						.2,
						.2,
						5.7,
						0,
						0,
						0
					], t = [
						.2,
						.2,
						1.6,
						1,
						1,
						1
					], i = .018, a = 16, h = 7) : r === 2 ? (e = [
						35,
						3,
						28,
						0,
						0,
						0
					], t = [
						5,
						1.5,
						7,
						1,
						1,
						1
					], i = .0012, a = 38) : r === 3 ? (e = [
						1,
						1,
						1,
						1,
						0,
						0
					], t = [
						.45,
						.45,
						.45,
						.45,
						1,
						1
					], i = .006, a = 3.4) : r === 4 ? (e = [
						1,
						1,
						1,
						1,
						1,
						0
					], t = [
						.45,
						.45,
						.45,
						.45,
						.45,
						1
					], i = .006, a = 3.2) : r === 5 ? (e = [
						1,
						1,
						1,
						1,
						1,
						0
					], t = [
						.45,
						.45,
						.45,
						.45,
						.45,
						1
					], i = .006, a = 3.2) : r === 6 ? (e = [
						1,
						4,
						1,
						1,
						1,
						1
					], t = [
						.4,
						1.2,
						.4,
						.4,
						.4,
						.4
					], i = .0055, a = 4.8) : r === 7 ? (e = [
						.208186,
						0,
						0,
						0,
						0,
						0
					], t = [
						.08,
						1,
						1,
						1,
						1,
						1
					], i = .025, a = 7, h = 5.5) : r === 8 ? (e = [
						.95,
						.7,
						.6,
						3.5,
						.25,
						.1
					], t = [
						.22,
						.18,
						.18,
						.7,
						.12,
						.08
					], i = .01, a = 2.6) : r === 9 ? (e = [
						1.4,
						0,
						0,
						0,
						0,
						0
					], t = [
						.32,
						1,
						1,
						1,
						1,
						1
					], i = .0045, a = 8.6) : r === 10 ? (e = [
						2.24,
						.43,
						-.65,
						-2.43,
						0,
						0
					], t = [
						.4,
						.4,
						.4,
						.4,
						1,
						1
					], a = 2.6, n = 70) : r === 11 ? (e = [
						1.4,
						-2.3,
						2.4,
						-2.1,
						0,
						0
					], t = [
						.55,
						.55,
						.55,
						.55,
						1,
						1
					], a = 2.7, n = 70) : r === 12 ? (e = [
						-1.4,
						1.6,
						1,
						.7,
						0,
						0
					], t = [
						.55,
						.55,
						.35,
						.35,
						1,
						1
					], a = 2.8, n = 70) : r === 13 ? (e = [
						1.4,
						.3,
						0,
						0,
						0,
						0
					], t = [
						.25,
						.1,
						1,
						1,
						1,
						1
					], a = 1.9, n = 80) : r === 14 ? (e = [
						.918,
						.4,
						6,
						0,
						0,
						0
					], t = [
						.08,
						.3,
						1.2,
						1,
						1,
						1
					], a = 2.9, n = 90) : r === 15 ? (e = [
						1.2,
						0,
						0,
						0,
						0,
						0
					], t = [
						1,
						1,
						1,
						1,
						1,
						1
					], a = 3.7, n = 30) : r === 16 ? (e = [
						.2,
						-1,
						1,
						.3,
						1.2,
						0
					], t = [
						.15,
						.35,
						.35,
						.2,
						.35,
						1
					], i = .018, a = 2.4) : r === 17 ? (e = [
						.4,
						10,
						5,
						.175,
						5,
						0
					], t = [
						.12,
						2,
						1.3,
						.08,
						.8,
						1
					], i = .005, a = 2.8) : r === 18 ? (e = [
						.14,
						.1,
						0,
						0,
						0,
						0
					], t = [
						.08,
						.08,
						1,
						1,
						1,
						1
					], i = .006, a = 4) : r === 19 ? (e = [
						15.6,
						28,
						-1.143,
						-.714,
						0,
						0
					], t = [
						3,
						6,
						.28,
						.22,
						1,
						1
					], i = .006, a = 3.8) : (e = [
						40,
						.5,
						20,
						.65,
						0,
						.833
					], t = [
						2,
						.06,
						1.2,
						.03,
						1,
						.25
					], i = 75e-5, a = 18, h = 10, n = 260), {
						defaults: e,
						scales: t,
						dt: i,
						viewScale: a,
						seedScale: h,
						warmup: n,
						discrete: Ha(r)
					};
				}
				function ba(r, e, t, i) {
					for (var a = [
						o(e.constantA, -1.5, 1.5),
						o(e.constantB, -1.5, 1.5),
						o(e.constantC, -1.5, 1.5),
						o(e.constantD, -1.5, 1.5),
						0,
						0
					], h = o(e.constantMotion, 0, 2.5), n = i * o(e.constantDrift, -24, 24) * .78 + z(e.seed, .37) * 6 + r * .73, M = [], v = 0; v < 6; v++) {
						var f = t.scales[v] || 1, m = Math.sin(n + v * 1.618) * f * h * .12;
						M[v] = t.defaults[v] + a[v] * f + m;
					}
					return M;
				}
				function W(r, e, t, i) {
					var a = K(e * 17.13 + 1) - .5, h = K(e * 23.71 + 2) - .5, n = K(e * 31.19 + 3) - .5, M = t.seedScale;
					r === 1 ? (i.x = a * 12, i.y = h * 12, i.z = K(e * 9.17 + 4) * 8) : r === 7 ? (i.x = a * 6, i.y = h * 6, i.z = n * 6) : r === 15 ? (i.x = a * 6.28318530718, i.y = h * 6.28318530718, i.z = 0) : r === 20 ? (i.x = a * M, i.y = h * M, i.z = 30 + n * M * 2) : (i.x = a * M, i.y = h * M, i.z = n * M);
				}
				function X(r, e, t, i) {
					var a = e.x, h = e.y, n = e.z, M, v, f, m, u;
					if (r === 0) M = a + t[0] * (h - a) * i, v = h + (a * (t[1] - n) - h) * i, f = n + (a * h - t[2] * n) * i;
					else if (r === 1) M = a + (-h - n) * i, v = h + (a + t[0] * h) * i, f = n + (t[1] + n * (a - t[2])) * i;
					else if (r === 2) M = a + t[0] * (h - a) * i, v = h + ((t[2] - t[0]) * a - a * n + t[2] * h) * i, f = n + (a * h - t[1] * n) * i;
					else if (r === 3) M = a + h * i, v = h + (-t[0] * a + t[1] * h * n) * i, f = n + (t[2] - t[3] * h * h) * i;
					else if (r === 4) M = a + t[0] * h * n * i, v = h + (t[1] * a - t[2] * h) * i, f = n + (t[3] - t[4] * a * h) * i;
					else if (r === 5) M = a + t[0] * h * n * i, v = h + (t[1] * a - t[2] * h) * i, f = n + (t[3] - t[4] * a * a) * i;
					else if (r === 6) M = a + (-t[0] * a - t[1] * h) * i, v = h + (t[2] * a + t[3] * n * n) * i, f = n + (t[4] + t[5] * a) * i;
					else if (r === 7) M = a + (Math.sin(h) - t[0] * a) * i, v = h + (Math.sin(n) - t[0] * h) * i, f = n + (Math.sin(a) - t[0] * n) * i;
					else if (r === 8) M = a + ((n - t[1]) * a - t[3] * h) * i, v = h + (t[3] * a + (n - t[1]) * h) * i, f = n + (t[2] + t[0] * n - n * n * n / 3 - (a * a + h * h) * (1 + t[4] * n) + t[5] * n * a * a * a) * i;
					else if (r === 9) M = a + (-t[0] * a - 4 * h - 4 * n - h * h) * i, v = h + (-t[0] * h - 4 * n - 4 * a - n * n) * i, f = n + (-t[0] * n - 4 * a - 4 * h - a * a) * i;
					else if (r === 10) M = Math.sin(t[0] * h) - n * Math.cos(t[1] * a), v = n * Math.sin(t[2] * a) - Math.cos(t[3] * h), f = Math.sin(a);
					else if (r === 11) M = Math.sin(t[0] * h) - Math.cos(t[1] * a), v = Math.sin(t[2] * a) - Math.cos(t[3] * h), f = 0;
					else if (r === 12) M = Math.sin(t[0] * h) + t[2] * Math.cos(t[0] * a), v = Math.sin(t[1] * a) + t[3] * Math.cos(t[1] * h), f = 0;
					else if (r === 13) M = 1 - t[0] * a * a + h, v = t[1] * a, f = 0;
					else if (r === 14) m = t[1] - t[2] / (1 + a * a + h * h), M = 1 + t[0] * (a * Math.cos(m) - h * Math.sin(m)), v = t[0] * (a * Math.sin(m) + h * Math.cos(m)), f = 0;
					else if (r === 15) v = Ca(h + t[0] * Math.sin(a)), M = Ca(a + v), f = 0;
					else if (r === 16) M = a + h * i, v = h + (-t[0] * h - t[1] * a - t[2] * a * a * a + t[3] * Math.cos(t[4] * n)) * i, f = n + i;
					else if (r === 17) M = a + (-t[0] * a + h + t[1] * h * n) * i, v = h + (-a - t[0] * h + t[2] * a * n) * i, f = n + (t[3] * n - t[4] * a * h) * i;
					else if (r === 18) M = a + (h * (n - 1 + a * a) + t[1] * a) * i, v = h + (a * (3 * n + 1 - a * a) + t[1] * h) * i, f = n + -2 * n * (t[0] + a * h) * i;
					else if (r === 19) u = t[3] * a + .5 * (t[2] - t[3]) * (Math.abs(a + 1) - Math.abs(a - 1)), M = a + t[0] * (h - a - u) * i, v = h + (a - h + n) * i, f = n + -t[1] * h * i;
					else {
						var c = Math.max(1, Math.ceil(i / 75e-5 - .001));
						u = i / c;
						for (var x = 0; x < c; x++) M = a + (t[0] * (h - a) + t[1] * a * n) * u, v = h + (t[2] * h - a * n) * u, f = n + (t[5] * n + a * h - t[3] * a * a) * u, a = M, h = v, n = f;
					}
					e.x = M, e.y = v, e.z = f;
				}
				function Aa(r, e, t, i, a, h) {
					var n = Math.max(0, Math.min(4, Math.round(z(t.projection, 3)))), M = o(t.cameraOrbit, -8, 8), v = o(t.projectionSpeed, -24, 24), f = z(t.rotation, 0) + h * v * .86 + h * M * .54, m = Math.cos(f), u = Math.sin(f), c = e.x * m - e.z * u, x = e.x * u + e.z * m, w = e.y, l, y;
					n === 0 ? (l = c, y = w) : n === 1 ? (l = c, y = x) : n === 2 ? (l = w, y = x) : (l = c + .42 * x, y = w - .28 * x);
					var S = c + .4 * x, C = w - .26 * x, F = o(t.projectionMix, 0, 1);
					if (l = l * (1 - F) + S * F, y = y * (1 - F) + C * F, n === 4) {
						var D = 1.0471975511966667, b = Math.atan2(y, l), P = Math.sqrt(l * l + y * y);
						b = Math.abs(((b + D * .5) % D + D) % D - D * .5), l = Math.cos(b) * P, y = Math.sin(b) * P;
					}
					var p = o(t.scale, .25, 4), O = o(t.zoom, .05, 8) * o(t.globalZoom, .05, 24), _ = i.viewScale / Math.max(p * O, 1e-4), T = s.width / Math.max(s.height, 1);
					a.u = .5 + l / Math.max(_ * T, 1e-4) * .5, a.v = .5 - y / Math.max(_, 1e-4) * .5, a.depth = x / Math.max(i.viewScale, 1e-4);
				}
				function sa(r, e, t, i, a, h, n) {
					if (!(r < -.02 || e < -.02 || r > 1.02 || e > 1.02)) {
						var M = Math.floor(r * s.width), v = Math.floor(e * s.height), f = Math.max(0, Math.min(3, z(n, .75)));
						if (f <= .05) {
							d(r, e, t, i, a, h);
							return;
						}
						for (var m = Math.max(1, Math.min(3, Math.ceil(f))), u = f + .65, c = -m; c <= m; c++) for (var x = -m; x <= m; x++) {
							var w = Math.sqrt(x * x + c * c);
							if (!(w > u)) {
								var l = M + x, y = v + c;
								if (!(l < 0 || y < 0 || l >= s.width || y >= s.height)) {
									var S = Math.max(0, (u - w) / u), C = h * S * S;
									if (!(C <= 0)) {
										var F = y * s.width + l;
										s.r[F] += t * C, s.g[F] += i * C, s.b[F] += a * C;
									}
								}
							}
						}
					}
				}
				function Da(r, e, t, i, a, h) {
					W(r, h, a, e);
					for (var n = a.discrete ? Math.max(a.warmup, 120) : Math.max(400, Math.min(6e3, Math.round(14 / Math.max(i, 1e-5)))), M = 0; M < n; M++) X(r, e, t, i), R(e) || W(r, h + M * 13 + 7, a, e);
					r === 16 && (e.z = e.z % (6.28318530718 / Math.max(Math.abs(t[4]), .05)));
				}
				function Ja(r, e, t, i, a, h) {
					var n = s.resetKey + "|" + r + "|" + e;
					if (!(s.particles && s.particleKey === n)) {
						s.particleKey = n, s.particles = new Float64Array(e * 3);
						for (var M = {
							x: 0,
							y: 0,
							z: 0
						}, v = 0, f = 0, m = 0, u = 0; u < e; u++) Da(r, M, t, i, a, u * 7.31 + h * 1e4 + 1), s.particles[u * 3] = M.x, s.particles[u * 3 + 1] = M.y, s.particles[u * 3 + 2] = M.z;
						for (var c = [], x = Math.max(a.viewScale * 30, 60), w = 0; w < Math.min(e, 48); w++) {
							M.x = s.particles[w * 3], M.y = s.particles[w * 3 + 1], M.z = s.particles[w * 3 + 2];
							for (var l = c.length, y = 0; y < 160; y++) {
								if (X(r, M, t, i), !R(M) || Math.abs(M.x) > x || Math.abs(M.y) > x || Math.abs(M.z) > x) {
									c.length = l;
									break;
								}
								r === 16 && (M.z = M.z % (6.28318530718 / Math.max(Math.abs(t[4]), .05))), y % 4 === 0 && c.push(M.x, M.y, M.z);
							}
						}
						for (var S = Math.max(1, c.length / 3), C = 0; C < c.length; C += 3) v += c[C], f += c[C + 1], m += c[C + 2];
						for (var F = v / S, D = f / S, b = m / S, P = [], p = 0; p < c.length; p += 3) {
							var O = c[p] - F, _ = c[p + 1] - D, T = c[p + 2] - b;
							P.push(Math.sqrt(O * O + _ * _ + T * T));
						}
						P.sort(function(I, B) {
							return I - B;
						});
						var A = P.length ? P[Math.floor((P.length - 1) * .985)] : a.viewScale;
						(!isFinite(A) || A <= 0) && (A = a.viewScale), s.attractorFrame = {
							cx: isFinite(F) ? F : 0,
							cy: isFinite(D) ? D : 0,
							cz: isFinite(b) ? b : 0,
							radius: A
						}, s.attractorSpeed = 0;
					}
				}
				function Pa(r) {
					for (var e = r.params || {}, t = j(r), i = Math.max(0, Math.min(20, Math.round(z(e.mode, 0)))), a = Fa(i), h = ba(i, e, a, t), n = Math.floor(o(r.batchSize, 8, 1200)), M = Math.floor(o(e.steps, 80, 1800)), v = o(e.dt, .05, 4), f = a.discrete ? 1 : a.dt * v, m = a.discrete ? a.warmup : Math.min(Math.max(a.warmup, Math.floor(M * .35)), 620), u = o(e.orbitSpeed, -24, 24), c = o(e.depthMix, -1, 1), x = o(e.trailWidth, .35, 3.5), w = z(e.seed, .29), l = s.frameCount * n, y = {
						x: 0,
						y: 0,
						z: 0
					}, S = {
						u: 0,
						v: 0,
						depth: 0
					}, C = 0; C < n; C++) {
						var F = l + C + w * 1e4 + t * u * 29;
						W(i, F, a, y);
						for (var D = 0; D < m; D++) X(i, y, h, f), R(y) || W(i, F + D * 13, a, y);
						for (var b = 0; b < M; b++) {
							if (X(i, y, h, f), !R(y)) {
								W(i, F + b * 19, a, y);
								continue;
							}
							if (Aa(i, y, e, a, S, t), !(S.u < 0 || S.u > 1 || S.v < 0 || S.v > 1)) {
								var P = o(.5 + S.depth * c * .55, 0, 1), p = V(b / Math.max(M - 1, 1) * .36 + i * .071 + P * .27 + t * .34 * u), O = .58 + .42 * Math.sin(6.28318530718 * (p + 0)), _ = .58 + .42 * Math.sin(6.28318530718 * (p + .33)), T = .58 + .42 * Math.sin(6.28318530718 * (p + .66)), A = .3 + .7 * P;
								sa(S.u, S.v, O, _, T, A, x);
							}
						}
					}
					return s.frameCount++, n;
				}
				function Qa(r) {
					var e = r.params || {}, t = j(r), i = Math.max(0, Math.min(20, Math.round(z(e.mode, 0)))), a = Fa(i);
					if (a.discrete) return Pa(r);
					var h = ba(i, e, a, t), n = Math.floor(o(r.batchSize, 8, 600)), M = Math.floor(o(e.steps, 80, 1800)), v = o(e.dt, .05, 4), f = a.discrete ? 1 : a.dt * v, m = o(e.orbitSpeed, -24, 24), u = o(e.depthMix, -1, 1), c = o(e.trailWidth, .35, 3.5);
					Ja(i, n, h, f, a, z(e.seed, .29));
					var x = s.attractorFrame;
					if (i === 6 || x.radius < a.viewScale * .03) return Pa(r);
					for (var w = {
						viewScale: x.radius * (a.discrete ? 1.08 : 1.18),
						scales: a.scales
					}, l = {
						x: 0,
						y: 0,
						z: 0
					}, y = {
						x: 0,
						y: 0,
						z: 0
					}, S = {
						u: 0,
						v: 0,
						depth: 0
					}, C = 0, F = 0, D = s.attractorSpeed > 0 ? s.attractorSpeed : 0, b = 0, P = 0, p = 0, O = 0, _ = i === 16 ? 6.28318530718 / Math.max(Math.abs(h[4]), .05) : 0, T = t * .34 * m, A = 0; A < n; A++) {
						l.x = s.particles[A * 3], l.y = s.particles[A * 3 + 1], l.z = s.particles[A * 3 + 2];
						for (var I = 0; I < M; I++) {
							var B = l.x, N = l.y, q = l.z;
							if (X(i, l, h, f), _ > 0 && (l.z = l.z % _), !R(l)) {
								Da(i, l, h, f, a, A * 3.7 + t * 11 + I);
								continue;
							}
							var g = l.x - B, Z = l.y - N, ea = _ > 0 ? 0 : l.z - q, H = Math.sqrt(g * g + Z * Z + ea * ea);
							if (C += H, F++, !(I & 15) && (b += l.x, P += l.y, p += l.z, O++), y.x = l.x - x.cx, y.y = l.y - x.cy, y.z = l.z - x.cz, Aa(i, y, e, w, S, t), !(S.u < 0 || S.u > 1 || S.v < 0 || S.v > 1)) {
								var J = o(.5 + S.depth * u * .55, 0, 1), ia = D > 0 ? H / (D * 2.2) : .5, k = V(Math.min(ia, 1.4) * .42 + i * .071 + J * .27 + T), G = Math.pow(.5 + .5 * Math.sin(6.28318530718 * (k + 0)), 1.7), la = Math.pow(.5 + .5 * Math.sin(6.28318530718 * (k + .33)), 1.7), E = Math.pow(.5 + .5 * Math.sin(6.28318530718 * (k + .66)), 1.7), oa = .3 + .7 * J;
								sa(S.u, S.v, G, la, E, oa, c);
							}
						}
						s.particles[A * 3] = l.x, s.particles[A * 3 + 1] = l.y, s.particles[A * 3 + 2] = l.z;
					}
					if (F > 0) {
						var na = C / F;
						s.attractorSpeed = D > 0 ? D * .9 + na * .1 : na;
					}
					return O > 0 && (x.cx = x.cx * .94 + b / O * .06, x.cy = x.cy * .94 + P / O * .06, x.cz = x.cz * .94 + p / O * .06), s.frameCount++, n;
				}
				function pa(r) {
					return !isFinite(r.x) || !isFinite(r.y) || Math.abs(r.x) > 64 || Math.abs(r.y) > 64 ? (r.x = 0, r.y = 0, !1) : (r.x = o(r.x, -12, 12), r.y = o(r.y, -12, 12), !0);
				}
				function fa(r, e, t, i, a) {
					var h = e * e + t * t, n = Math.sqrt(Math.max(h, 1e-6)), M = Math.atan2(t, e), v;
					if (r = Math.max(0, Math.min($ - 1, Math.round(z(r, 0)))), r === 0) a.x = e, a.y = t;
					else if (r === 1) {
						var f = Math.sin(h), m = Math.cos(h);
						a.x = e * f - t * m, a.y = e * m + t * f;
					} else if (r === 2) {
						var u = 1 / Math.max(h, .025);
						a.x = e * u, a.y = t * u;
					} else if (r === 3) a.x = n * Math.sin(M * n), a.y = -n * Math.cos(M * n);
					else if (r === 4) a.x = (e - t) * (e + t) / Math.max(n, .025), a.y = 2 * e * t / Math.max(n, .025);
					else if (r === 5) v = Math.sqrt(n), M = M * .5 + (K(i) > .5 ? 3.14159265359 : 0), a.x = v * Math.cos(M), a.y = v * Math.sin(M);
					else if (r === 6) a.x = M / 3.14159265359 * Math.sin(3.14159265359 * n), a.y = M / 3.14159265359 * Math.cos(3.14159265359 * n);
					else if (r === 7) a.x = (Math.cos(M) + Math.sin(n)) / Math.max(n, .04), a.y = (Math.sin(M) - Math.cos(n)) / Math.max(n, .04);
					else if (r === 8) a.x = Math.sin(M) * Math.cos(n), a.y = Math.cos(M) * Math.sin(n);
					else if (r === 9) a.x = Math.sin(M) / Math.max(n, .04), a.y = n * Math.cos(M);
					else if (r === 10) a.x = (Math.sin(1.25 * t) - Math.cos(1.75 * e)) * .62, a.y = (Math.sin(1.45 * e) - Math.cos(1.15 * t)) * .62;
					else if (r === 11) {
						var c = .34;
						v = (n + c * c) % (2 * c * c) - c * c + n * (1 - c * c), a.x = v * Math.cos(M), a.y = v * Math.sin(M);
					} else if (r === 12) a.x = e * .32 + (K(i * 1.17 + 3.1) - .5) * 1.2, a.y = t * .32 + (K(i * 1.91 + 7.4) - .5) * 1.2;
					else if (r === 13) {
						var x = 7 + Math.floor(K(i + 9) * 5), w = Math.sin(M * x);
						v = n * .55 + w * .42, a.x = v * Math.cos(M), a.y = v * Math.sin(M);
					} else if (r === 14) a.x = Math.sin(e), a.y = Math.sin(t);
					else if (r === 15) a.x = M / 3.14159265359, a.y = n - 1;
					else if (r === 16) a.x = n * Math.sin(M + n), a.y = n * Math.cos(M - n);
					else if (r === 17) {
						var l = Math.sin(M + n), y = Math.cos(M - n);
						a.x = n * (l * l * l + y * y * y), a.y = n * (l * l * l - y * y * y);
					} else if (r === 18) a.x = e < 0 ? e * 2 : e, a.y = t < 0 ? t * .5 : t;
					else if (r === 19) {
						var S = 2 / (n + 1);
						a.x = S * t, a.y = S * e;
					} else if (r === 20) {
						var C = 2 / (n + 1);
						a.x = C * e, a.y = C * t;
					} else if (r === 21) {
						var F = 4 / (h + 4);
						a.x = F * e, a.y = F * t;
					} else if (r === 22) a.x = Math.sin(e), a.y = t;
					else if (r === 23) v = Math.pow(Math.max(n, 1e-6), Math.sin(M)), a.x = v * Math.cos(M), a.y = v * Math.sin(M);
					else if (r === 24) {
						var D = Math.max(-4, Math.min(4, t));
						a.x = Math.cos(3.14159265359 * e) * Math.cosh(D), a.y = -Math.sin(3.14159265359 * e) * Math.sinh(D);
					} else if (r === 25) {
						var b = Math.exp(Math.max(-5, Math.min(4, e - 1)));
						a.x = b * Math.cos(3.14159265359 * t), a.y = b * Math.sin(3.14159265359 * t);
					} else if (r === 26) {
						var m = Math.cos(t);
						a.x = Math.sin(e) / (Math.abs(m) > 1e-6 ? m : m < 0 ? -1e-6 : 1e-6), a.y = Math.max(-8, Math.min(8, Math.tan(Math.max(-1.35, Math.min(1.35, t)))));
					} else if (r === 27) {
						var P = 1 / (e * e - t * t + (e >= t ? 1e-4 : -1e-4));
						P = Math.min(8, Math.abs(P)), a.x = e * P, a.y = t * P;
					} else if (r === 28) {
						var p = .7853991633975, O = M % p;
						O < 0 && (O += p), M += O > p * .5 ? -p * .5 : p * .5, a.x = n * Math.cos(M), a.y = n * Math.sin(M);
					} else if (r === 29) {
						var _ = 1 + .3 * (e * e - t * t), T = .6 * e * t, A = Math.max(_ * _ + T * T, .001);
						a.x = (e * _ + t * T) / A, a.y = (t * _ - e * T) / A;
					} else if (r === 30) {
						var I = 1.256637061436, B = M - I * Math.floor(M / I);
						B > I * .5 && (B -= I);
						var N = (1 / Math.max(Math.cos(B), .05) - 1 + 1) / Math.max(n, .05);
						a.x = e * Math.min(8, N), a.y = t * Math.min(8, N);
					} else if (r === 31) {
						var q = 3.14159265359 * K(i + 17), g = Math.sin(q), Z = Math.cos(q);
						a.x = g, a.y = g * g / (Math.abs(Z) > 1e-6 ? Z : Z < 0 ? -1e-6 : 1e-6);
					} else if (r === 32) {
						var ea = 3.14159265359 * K(i + 23), H = Math.max(-8, Math.min(8, Math.tan(ea))) / Math.max(h, .025);
						a.x = H * Math.cos(e), a.y = H * Math.sin(t);
					} else if (r === 33) {
						var J = n * K(i + 29), ia = Math.cos(J), k = Math.sin(J);
						a.x = e * (ia + k), a.y = e * (ia - k);
					} else if (r === 34) a.x = e + .5 * Math.sin(2 * t), a.y = t + .5 * Math.sin(2 * e);
					else if (r === 35) a.x = e + .1 * Math.sin(Math.max(-8, Math.min(8, Math.tan(3 * t)))), a.y = t + .1 * Math.sin(Math.max(-8, Math.min(8, Math.tan(3 * e))));
					else if (r === 36) {
						var N = n * (.3 + .9 * (.5 + .5 * Math.sin(6 * M)));
						a.x = N * Math.cos(M), a.y = N * Math.sin(M);
					} else if (r === 37) {
						var G = .7853991633975, la = M + .5 - G * Math.floor((M + .5) / G);
						M += la > G * .5 ? -G * .5 : G * .5, a.x = n * Math.sin(M), a.y = n * Math.cos(M);
					} else if (r === 38) {
						var E = .25;
						v = n - 2 * E * Math.floor((n + E) / (2 * E)) + n * (1 - E), a.x = v * Math.sin(M), a.y = v * Math.cos(M);
					} else if (r === 39) {
						var oa = .70710678118, na = .70710678118, Ka = 1 - t * oa, _a = Math.max(-8, Math.min(8, 1 / (Math.abs(Ka) > 1e-6 ? Ka : 1e-6)));
						a.x = e * _a, a.y = t * na * _a;
					} else if (r === 40) {
						var La = K(i + 31), Ba = 6.28318530718 * K(i + 37);
						a.x = La * e * Math.cos(Ba), a.y = La * t * Math.sin(Ba);
					} else if (r === 41) {
						var xa = 2, sr = Math.floor(xa * K(i + 41));
						M = (M + 6.28318530718 * sr) / xa, v = Math.pow(Math.max(h, 1e-6), 1 / (2 * xa)), a.x = v * Math.cos(M), a.y = v * Math.sin(M);
					} else if (r === 42) {
						var ca = 3, fr = Math.floor(ca * K(i + 43));
						M = ((K(i + 47) > .5 ? 1 : -1) * M + 6.28318530718 * fr) / ca, v = Math.pow(Math.max(h, 1e-6), 1 / (2 * ca)), a.x = v * Math.cos(M), a.y = v * Math.sin(M);
					} else if (r === 43) {
						var Na = 6.28318530718 * K(i + 53), Va = Math.sqrt(K(i + 59));
						a.x = Va * Math.cos(Na), a.y = Va * Math.sin(Na);
					} else if (r === 44) {
						var ga = 6, qa = 6.28318530718 * (Math.floor(ga * K(i + 61) + .5) + K(i + 67) * .5) / ga, Ga = K(i + 71);
						a.x = Ga * Math.cos(qa), a.y = Ga * Math.sin(qa);
					} else {
						var ya = Math.cos(n), Q = 1 / (Math.abs(ya) > 1e-6 ? ya : ya < 0 ? -1e-6 : 1e-6);
						Q = Math.max(-8, Math.min(8, Q)), a.x = e, a.y = t + (Q > 0 ? Q - 1 : Q + 1);
					}
					pa(a);
				}
				function $a(r, e, t, i, a, h) {
					var n = z(a.motionTime, s.frameCount / 60), M = o(a.scale, .45, 2.2), v = z(a.rotate, 0), f = o(a.affineDrift, -12, 12), m = o(a.translateX, -1.5, 1.5), u = o(a.translateY, -1.5, 1.5), c = o(a.shearX, -.9, .9), x = o(a.shearY, -.9, .9), w = 6.28318530718;
					if (r === 0) {
						var l = -1.57079632679 + e % 3 * w / 3 + v;
						h.x = i.x * .5 + Math.cos(l) * .72 + m * .18, h.y = i.y * .5 + Math.sin(l) * .72 + u * .18;
						return;
					}
					var y = e / Math.max(t, 1) * w + r * .271 + v + n * f * .42, S = Math.cos(y), C = Math.sin(y), F = (.48 + .11 * Math.sin(r * 1.7 + e)) * M * (.94 + .08 * Math.sin(n * .82 + e * 2.17)), D = Math.cos(y + r * .19) * (.42 + .08 * Math.sin(r)), b = Math.sin(y - r * .13) * (.42 + .08 * Math.cos(r)), P = i.x * S - i.y * C, p = i.x * C + i.y * S;
					h.x = (P + c * p * .35) * F + D + m * .32, h.y = (p + x * P * .35) * F + b + u * .32;
				}
				function Ta(r) {
					return r = Math.max(0, Math.min(Ma - 1, Math.round(z(r, 0)))), typeof ua[r] == "number" ? ua[r] : 0;
				}
				function ja(r) {
					return r = Math.max(0, Math.min(Ma - 1, Math.round(z(r, 0)))), typeof Sa[r] == "number" ? Sa[r] : (Ta(r) + 3) % $;
				}
				function Ia(r, e, t, i, a, h) {
					var n = z(t.motionTime, s.frameCount / 60), M = Math.max(2, Math.min(6, Math.round(z(t.xformCount, 4)))), v = Math.floor(K(i * 13.71) * M);
					v >= M && (v = M - 1), $a(r, v, M, e, t, a);
					var f = Ta(r), m = ja(r), u = o(t.variationWeights, 0, 1), c = o(t.variationMorph, 0, 1);
					c > .5 && (m = (m + Math.floor((c - .5) * 2 * 11.999)) % $), u = o(u * .72 + c * (.1 + .1 * Math.sin(n * .95 + r)), 0, 1), fa(f, a.x, a.y, i + v * 19, a), fa(m, a.x, a.y, i + v * 31, h), e.x = a.x * (1 - u) + h.x * u, e.y = a.y * (1 - u) + h.y * u;
					var x = o(t.finalTransform, 0, 1);
					if (r === 10 && (x *= .35), x > .001) {
						var w = .35 + r * .11 + n * .32, l = Math.cos(w), y = Math.sin(w), S = (e.x * l - e.y * y) * (.82 + .18 * Math.sin(r)), C = (e.x * y + e.y * l) * (.82 + .18 * Math.cos(r));
						fa((f + 5) % $, S, C, i + 101, h), e.x = e.x * (1 - x) + h.x * x, e.y = e.y * (1 - x) + h.y * x;
					}
					return pa(e) || (e.x = (K(i + 5) - .5) * .8, e.y = (K(i + 8) - .5) * .8), v;
				}
				function da(r, e, t, i, a, h) {
					for (var n = z(a.motionTime, s.frameCount / 60), M = Math.max(1, Math.min(12, Math.round(z(a.symmetry, 5)))), v = o(a.symmetryPulse, 0, 1), f = M, m = Math.sin(n * .95 + r) * v * .22, u = o(a.globalZoom, .05, 24), c = 1.85 / Math.max(u, 1e-4), x = s.width / Math.max(s.height, 1), w = o(a.colorMix, 0, 1), l = o(a.splatRadius, 0, 2.5), y = r === 10 ? Math.max(l, .85) : l, S = (r === 10 ? 1.18 : .82) / Math.sqrt(f), C = r === 10 ? .48 : 1, F = 0; F < f; F++) {
						var D = F / f * 6.28318530718 + m, b = Math.cos(D), P = Math.sin(D), p = (e.x * b - e.y * P) * C, O = (e.x * P + e.y * b) * C, _ = .5 + p / Math.max(c * x, 1e-4) * .5, T = .5 - O / Math.max(c, 1e-4) * .5;
						if (!(_ < 0 || _ > 1 || T < 0 || T > 1)) {
							var A = V(r * .071 + t * .137 + i * .031 + F / f * w);
							sa(_, T, .56 + .44 * Math.cos(6.28318530718 * (A + 0)), .56 + .44 * Math.cos(6.28318530718 * (A + .33)), .56 + .44 * Math.cos(6.28318530718 * (A + .66)), S, y);
						}
					}
				}
				function ar(r) {
					var e = r.params || {};
					e.motionTime = j(r) * o(e.motionRate, 0, 12);
					for (var t = Math.max(0, Math.min(Ma - 1, Math.round(z(e.mode, 1)))), i = Math.floor(o(r.batchSize, 1e3, 7e4)), a = Math.floor(o(e.warmup, 4, 80)), h = Math.floor(o(e.plotOrbit, 1, 8)), n = z(e.seed, .43), M = s.frameCount * i, v = {
						x: 0,
						y: 0
					}, f = {
						x: 0,
						y: 0
					}, m = {
						x: 0,
						y: 0
					}, u = i, c = 0; c < i; c++) {
						if ((c & 255) === 255 && Date.now() > s.deadline) {
							u = c + 1;
							break;
						}
						var x = M + c + n * 1e4;
						v.x = (K(x * .754877 + 1) - .5) * 1.2, v.y = (K(x * .56984 + 2) - .5) * 1.2;
						for (var w = 0, l = 0; l < a; l++) w = Ia(t, v, e, x + l * 17, f, m);
						for (var y = 0; y < h; y++) w = Ia(t, v, e, x + (a + y) * 17, f, m), da(t, v, w, y, e, x);
					}
					return s.frameCount++, u;
				}
				var Y = 0;
				function rr() {
					for (var r = 0, e = 0, t = 0, i = 0; i < s.r.length; i++) {
						var a = Math.max(s.r[i], s.g[i], s.b[i]);
						a > r && (r = a), a > 0 && (e += a, t++);
					}
					return Y = t ? e / t : 0, r;
				}
				var aa = null;
				function tr(r) {
					return (!aa || aa.length < r) && (aa = new Float32Array(r)), aa;
				}
				function er(r) {
					var e = s.r.length;
					if (!e) return r;
					for (var t = Math.min(e, 24e3), i = e / t, a = tr(t), h = 0, n = 0, M = 0; M < t; M++) {
						var v = Math.min(e - 1, Math.floor(M * i) + n), f = Math.max(s.r[v], s.g[v], s.b[v]);
						f > 0 && (a[h++] = f);
					}
					if (h < 32) return r;
					var m = a.subarray(0, h).sort()[Math.floor((h - 1) * .992)];
					return Math.max(Math.min(r, m * 1.6), r * .015, 1e-4);
				}
				var L = 1024, ra = new Float32Array(L + 1), ta = new Float32Array(L + 1), U = new Float32Array(L * 3), Oa = "";
				function ir(r, e, t) {
					var i = r.toFixed(4) + "|" + e.toFixed(4) + "|" + t;
					if (i !== Oa) {
						Oa = i;
						for (var a = 0; a <= L; a++) {
							var h = a / L;
							ra[a] = Math.pow(h, r), ta[a] = Math.pow(h, 1 / e) * 255;
						}
						if (t >= 0) for (var n = 0; n < L; n++) {
							var M = Mr(n / L, t);
							U[n * 3] = M[0], U[n * 3 + 1] = M[1], U[n * 3 + 2] = M[2];
						}
					}
				}
				function nr(r, e) {
					var t = r.image;
					if (t && t.byteLength === e) {
						var i = new Uint8ClampedArray(t);
						return i.fill(0), i;
					}
					return new Uint8ClampedArray(e);
				}
				function hr(r) {
					var e = r.tonemap || {}, t = o(e.exposure, .01, 12), i = o(e.gamma, .2, 4), a = o(e.gain, .05, 8), h = o(e.glow, 0, 4), n = o(e.curve, .25, 3), M = Math.floor(o(e.palette, -1, 5, -1)), v = z(e.colorPhase, 0);
					ir(n, i, M);
					for (var f = Math.max(rr(), 1e-4), m = er(f), u = z(r.whiteScale, 0), c = u > 0 && Y > 0 ? Math.min(f, Math.max(f * .015, Y * u, 1e-4)) : m, x = a / Math.log(1 + c * t), w = h * .08, l = .3, y = v - Math.floor(v), S = nr(r, s.width * s.height * 4), C = s.r, F = s.g, D = s.b, b = 0, P = 0; b < C.length; b++, P += 4) {
						S[P + 3] = 255;
						var p = C[b], O = F[b], _ = D[b];
						if (!(p <= 0 && O <= 0 && _ <= 0)) {
							var T = Math.min(1, Math.log(1 + p * t) * x), A = Math.min(1, Math.log(1 + O * t) * x), I = Math.min(1, Math.log(1 + _ * t) * x);
							if (T = ra[T * L | 0], A = ra[A * L | 0], I = ra[I * L | 0], M >= 0) {
								var B = (T + A + I) / 3, N = B + y;
								N = N - Math.floor(N);
								var q = (N * L | 0) * 3;
								T = T * (1 - l) + U[q] * B * l, A = A * (1 - l) + U[q + 1] * B * l, I = I * (1 - l) + U[q + 2] * B * l;
							}
							var g = (T > A ? T > I ? T : I : A > I ? A : I) * w;
							T = Math.min(1, T + g), A = Math.min(1, A + g), I = Math.min(1, I + g), S[P] = ta[T * L | 0], S[P + 1] = ta[A * L | 0], S[P + 2] = ta[I * L | 0];
						}
					}
					return {
						image: S,
						maxValue: f,
						whiteScale: Y > 0 ? m / Y : 0
					};
				}
				function Mr(r, e) {
					r = V(r);
					var t = e < 1 ? [
						0,
						.12,
						.32
					] : e < 2 ? [
						.03,
						.22,
						.62
					] : e < 3 ? [
						.58,
						.18,
						.04
					] : e < 4 ? [
						.74,
						.42,
						.12
					] : [
						.12,
						.42,
						.72
					];
					return [
						.5 + .5 * Math.cos(6.28318530718 * (r + t[0])),
						.5 + .5 * Math.cos(6.28318530718 * (r + t[1])),
						.5 + .5 * Math.cos(6.28318530718 * (r + t[2]))
					];
				}
				function vr(r) {
					Za(r), ka(r.decay === void 0 ? 1 : r.decay);
					var e = 0, t = String(r.densityType || "test_spiral"), i = o(r.budgetMs === void 0 ? 12 : r.budgetMs, 0, 40), a = Date.now();
					s.deadline = a + Math.min(80, Math.max(1, z(r.deadlineMs, 80)));
					var h = 0;
					do
						t === "test_spiral" ? e += Ea(r) : t === "buddhabrot" ? e += Ya(r) : t === "attractor" ? e += Qa(r) : t === "flam3" && (e += ar(r)), h++;
					while (t !== "test_spiral" && h < 16 && Date.now() - a < i && Date.now() < s.deadline);
					var n = hr(r);
					self.postMessage({
						type: "frame",
						requestId: r.requestId,
						generation: s.generation,
						resetKey: s.resetKey,
						width: s.width,
						height: s.height,
						frameCount: s.frameCount,
						resetCount: s.resetCount,
						lastBatchSize: e,
						maxValue: n.maxValue,
						whiteScale: n.whiteScale,
						workerStatus: "ready",
						workMs: Date.now() - a,
						image: n.image.buffer
					}, [n.image.buffer]);
				}
				self.onmessage = function(r) {
					var e = r.data || {};
					e.type === "accumulate" ? vr(e) : e.type === "reset" ? (za(e.width, e.height, e.resetKey, e.generation), self.postMessage({
						type: "reset",
						requestId: e.requestId,
						generation: s.generation,
						resetCount: s.resetCount,
						workerStatus: "ready"
					})) : e.type === "close" && self.close();
				};
			}
			typeof WorkerGlobalScope < "u" && ha instanceof WorkerGlobalScope ? ma() : ha && (ha.PsyDensityWorkerSource = "(" + ma.toString() + ")();");
		})(typeof self < "u" ? self : this), {};
	}
	Ua({});
})();
