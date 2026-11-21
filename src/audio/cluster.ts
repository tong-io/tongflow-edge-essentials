/**
 * Agglomerative clustering of speaker embeddings by cosine distance with
 * complete linkage, cut at a distance threshold or at a cluster count. Same
 * semantics as sherpa-onnx's FastClustering (fastcluster `hclust_fast` with
 * HCLUST_METHOD_COMPLETE, then `cutree_cdist` / `cutree_k`): merges are taken
 * in increasing height, and clusters are numbered in order of their first
 * member. Implemented with the nearest-neighbour-chain algorithm, O(n²) time
 * and n²/2 float32 memory.
 */

/** L2-normalize each row of a row-major [rows × dim] matrix in place. */
export function normalizeRows(m: Float32Array, rows: number, dim: number): void {
    for (let r = 0; r < rows; r++) {
        let s = 0;
        for (let d = 0; d < dim; d++) s += m[r * dim + d]! ** 2;
        const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
        for (let d = 0; d < dim; d++) m[r * dim + d] = m[r * dim + d]! * inv;
    }
}

export interface ClusterOptions {
    /** Cut where the complete-linkage cosine distance reaches this value (default 0.5). */
    threshold?: number;
    /** Exact number of clusters instead of a threshold (when > 0). */
    numClusters?: number;
}

/** Cluster label (0-based, in order of first member) for each row of `embeddings`. */
export function clusterEmbeddings(embeddings: Float32Array, rows: number, dim: number, o: ClusterOptions = {}): Int32Array {
    const labels = new Int32Array(rows);
    if (rows <= 1) return labels;
    const m = embeddings.slice(0, rows * dim);
    normalizeRows(m, rows, dim);
    const n = rows;
    const idx = (i: number, j: number) => (i < j ? i * n - (i * (i + 1)) / 2 + j - i - 1 : j * n - (j * (j + 1)) / 2 + i - j - 1);
    const dist = new Float32Array((n * (n - 1)) / 2);
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            let dot = 0;
            for (let d = 0; d < dim; d++) dot += m[i * dim + d]! * m[j * dim + d]!;
            dist[idx(i, j)] = Math.max(0, 1 - dot);
        }
    }
    // Nearest-neighbour chain; a merged cluster keeps the smaller index.
    const active = new Uint8Array(n).fill(1);
    const merges: { a: number; b: number; h: number }[] = [];
    const chain: number[] = [];
    let remaining = n;
    while (remaining > 1) {
        if (!chain.length) {
            let first = 0;
            while (!active[first]) first++;
            chain.push(first);
        }
        for (;;) {
            const a = chain[chain.length - 1]!;
            const prev = chain.length >= 2 ? chain[chain.length - 2]! : -1;
            let best = prev;
            let bestD = prev >= 0 ? dist[idx(a, prev)]! : Infinity;
            for (let c = 0; c < n; c++) {
                if (c === a || !active[c]) continue;
                const d = dist[idx(a, c)]!;
                if (d < bestD) {
                    bestD = d;
                    best = c;
                }
            }
            if (best === prev) {
                chain.length -= 2;
                const keep = Math.min(a, prev);
                const drop = Math.max(a, prev);
                merges.push({ a: keep, b: drop, h: bestD });
                active[drop] = 0;
                for (let c = 0; c < n; c++) {
                    if (!active[c] || c === keep) continue;
                    const k = idx(keep, c);
                    dist[k] = Math.max(dist[k]!, dist[idx(drop, c)]!);
                }
                remaining--;
                break;
            }
            chain.push(best);
        }
    }
    // Stable sort by height, then apply a prefix of the merges (union-find).
    const order = merges.map((_, i) => i).sort((x, y) => merges[x]!.h - merges[y]!.h || x - y);
    let apply: number;
    if (o.numClusters && o.numClusters > 0) apply = Math.max(0, n - Math.min(o.numClusters, n));
    else {
        const t = o.threshold ?? 0.5;
        apply = 0;
        while (apply < order.length && merges[order[apply]!]!.h < t) apply++;
    }
    const parent = new Int32Array(n).map((_, i) => i);
    const find = (x: number): number => {
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]!]!;
            x = parent[x]!;
        }
        return x;
    };
    for (let k = 0; k < apply; k++) {
        const { a, b } = merges[order[k]!]!;
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    }
    const ids = new Map<number, number>();
    for (let i = 0; i < n; i++) {
        const r = find(i);
        let id = ids.get(r);
        if (id === undefined) {
            id = ids.size;
            ids.set(r, id);
        }
        labels[i] = id;
    }
    return labels;
}
