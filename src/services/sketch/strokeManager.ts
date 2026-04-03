export interface SketchPoint {
    x: number;
    y: number;
    pressure: number;
}

export interface SketchStroke {
    id: number;
    color: string;
    width: number;
    points: SketchPoint[];
    bounds: {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
    };
}

/** Squared distance from point (px,py) to line segment (ax,ay)→(bx,by) */
function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
        const ex = px - ax;
        const ey = py - ay;
        return ex * ex + ey * ey;
    }
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    const projX = ax + t * dx;
    const projY = ay + t * dy;
    const fx = px - projX;
    const fy = py - projY;
    return fx * fx + fy * fy;
}

function clampPressure(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0.5;
    return Math.max(0.05, Math.min(1, value));
}

export class StrokeManager {
    private strokes: SketchStroke[] = [];
    private redoStack: SketchStroke[] = [];
    private currentStroke: SketchStroke | null = null;
    private nextId = 1;

    startStroke(x: number, y: number, pressure: number, color: string, width: number): void {
        const clampedPressure = clampPressure(pressure);
        const safeWidth = Math.max(1, Math.min(8, Math.round(width)));

        this.currentStroke = {
            id: this.nextId++,
            color,
            width: safeWidth,
            points: [{ x, y, pressure: clampedPressure }],
            bounds: { minX: x, minY: y, maxX: x, maxY: y }
        };
    }

    addPoint(x: number, y: number, pressure: number): void {
        if (!this.currentStroke) return;
        const clampedPressure = clampPressure(pressure);
        this.currentStroke.points.push({ x, y, pressure: clampedPressure });
        this.currentStroke.bounds.minX = Math.min(this.currentStroke.bounds.minX, x);
        this.currentStroke.bounds.minY = Math.min(this.currentStroke.bounds.minY, y);
        this.currentStroke.bounds.maxX = Math.max(this.currentStroke.bounds.maxX, x);
        this.currentStroke.bounds.maxY = Math.max(this.currentStroke.bounds.maxY, y);
    }

    commitStroke(): SketchStroke | null {
        if (!this.currentStroke) return null;
        const stroke = this.currentStroke;
        this.currentStroke = null;
        this.strokes.push(stroke);
        this.redoStack = [];
        return stroke;
    }

    cancelCurrentStroke(): void {
        this.currentStroke = null;
    }

    eraseAt(x: number, y: number, padding = 12): boolean {
        for (let i = this.strokes.length - 1; i >= 0; i--) {
            const stroke = this.strokes[i];
            // Quick bounding-box rejection
            const inBounds =
                x >= stroke.bounds.minX - padding &&
                x <= stroke.bounds.maxX + padding &&
                y >= stroke.bounds.minY - padding &&
                y <= stroke.bounds.maxY + padding;
            if (!inBounds) continue;

            // Point-level hit test: check distance to each segment
            if (this.hitTestStroke(stroke, x, y, padding)) {
                this.strokes.splice(i, 1);
                this.redoStack = [];
                return true;
            }
        }
        return false;
    }

    private hitTestStroke(stroke: SketchStroke, x: number, y: number, padding: number): boolean {
        const pts = stroke.points;
        const padSq = padding * padding;

        // Single-point stroke: distance to point
        if (pts.length === 1) {
            const dx = x - pts[0].x;
            const dy = y - pts[0].y;
            return dx * dx + dy * dy <= padSq;
        }

        // Multi-point stroke: distance to each line segment
        for (let j = 1; j < pts.length; j++) {
            if (distToSegmentSq(x, y, pts[j - 1].x, pts[j - 1].y, pts[j].x, pts[j].y) <= padSq) {
                return true;
            }
        }
        return false;
    }

    undo(): SketchStroke | null {
        const stroke = this.strokes.pop() || null;
        if (stroke) {
            this.redoStack.push(stroke);
        }
        return stroke;
    }

    redo(): SketchStroke | null {
        const stroke = this.redoStack.pop() || null;
        if (stroke) {
            this.strokes.push(stroke);
        }
        return stroke;
    }

    clear(): void {
        this.strokes = [];
        this.redoStack = [];
        this.currentStroke = null;
    }

    hasContent(): boolean {
        return this.strokes.length > 0 || !!this.currentStroke;
    }

    canUndo(): boolean {
        return this.strokes.length > 0;
    }

    canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    getStrokes(): readonly SketchStroke[] {
        return this.strokes;
    }

    getCurrentStroke(): SketchStroke | null {
        return this.currentStroke;
    }

    /** Bounding box of all committed strokes, or null if empty. */
    getContentBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
        if (this.strokes.length === 0) return null;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const stroke of this.strokes) {
            minX = Math.min(minX, stroke.bounds.minX);
            minY = Math.min(minY, stroke.bounds.minY);
            maxX = Math.max(maxX, stroke.bounds.maxX);
            maxY = Math.max(maxY, stroke.bounds.maxY);
        }
        return { minX, minY, maxX, maxY };
    }
}

