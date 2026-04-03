import { StrokeManager } from '../src/services/sketch/strokeManager';

describe('StrokeManager', () => {
    it('creates and commits a stroke', () => {
        const manager = new StrokeManager();
        manager.startStroke(10, 20, 0.5, '#000000', 3);
        manager.addPoint(15, 25, 0.8);
        manager.commitStroke();

        expect(manager.getStrokes()).toHaveLength(1);
        expect(manager.getStrokes()[0].points).toHaveLength(2);
        expect(manager.canUndo()).toBe(true);
        expect(manager.canRedo()).toBe(false);
    });

    it('supports undo and redo', () => {
        const manager = new StrokeManager();
        manager.startStroke(1, 1, 0.5, '#000000', 3);
        manager.commitStroke();
        manager.startStroke(2, 2, 0.5, '#000000', 3);
        manager.commitStroke();

        manager.undo();
        expect(manager.getStrokes()).toHaveLength(1);
        expect(manager.canRedo()).toBe(true);

        manager.redo();
        expect(manager.getStrokes()).toHaveLength(2);
        expect(manager.canRedo()).toBe(false);
    });

    it('eraseAt removes stroke when near a segment', () => {
        const manager = new StrokeManager();
        manager.startStroke(5, 5, 0.5, '#000000', 3);
        manager.addPoint(20, 20, 0.5);
        manager.commitStroke();
        manager.startStroke(100, 100, 0.5, '#000000', 3);
        manager.addPoint(120, 120, 0.5);
        manager.commitStroke();

        // Tap near the second stroke's segment
        const erased = manager.eraseAt(110, 110, 4);
        expect(erased).toBe(true);
        expect(manager.getStrokes()).toHaveLength(1);
        expect(manager.getStrokes()[0].bounds.maxX).toBe(20);
    });

    it('eraseAt does not remove stroke when inside bounding box but far from segments', () => {
        const manager = new StrokeManager();
        // Create an L-shaped stroke: (0,0)→(100,0)→(100,100)
        // Bounding box covers (0,0)→(100,100) but the interior (50,50) is far from any segment
        manager.startStroke(0, 0, 0.5, '#000000', 3);
        manager.addPoint(100, 0, 0.5);
        manager.addPoint(100, 100, 0.5);
        manager.commitStroke();

        // (50, 50) is inside bounding box but ~50px from nearest segment
        const erased = manager.eraseAt(50, 50, 10);
        expect(erased).toBe(false);
        expect(manager.getStrokes()).toHaveLength(1);
    });

    it('eraseAt hits single-point stroke', () => {
        const manager = new StrokeManager();
        manager.startStroke(50, 50, 0.5, '#000000', 3);
        manager.commitStroke();

        expect(manager.eraseAt(52, 52, 5)).toBe(true);
        expect(manager.getStrokes()).toHaveLength(0);
    });

    it('eraseAt misses single-point stroke when too far', () => {
        const manager = new StrokeManager();
        manager.startStroke(50, 50, 0.5, '#000000', 3);
        manager.commitStroke();

        expect(manager.eraseAt(70, 70, 5)).toBe(false);
        expect(manager.getStrokes()).toHaveLength(1);
    });

    it('eraseAt clears redo stack', () => {
        const manager = new StrokeManager();
        manager.startStroke(10, 10, 0.5, '#000000', 3);
        manager.addPoint(20, 20, 0.5);
        manager.commitStroke();
        manager.startStroke(50, 50, 0.5, '#000000', 3);
        manager.addPoint(60, 60, 0.5);
        manager.commitStroke();
        manager.undo();
        expect(manager.canRedo()).toBe(true);

        manager.eraseAt(15, 15, 10);
        expect(manager.canRedo()).toBe(false);
    });

    it('clear resets strokes and redo stack', () => {
        const manager = new StrokeManager();
        manager.startStroke(1, 1, 0.5, '#000000', 3);
        manager.commitStroke();
        manager.undo();
        expect(manager.canRedo()).toBe(true);

        manager.clear();
        expect(manager.getStrokes()).toHaveLength(0);
        expect(manager.canRedo()).toBe(false);
        expect(manager.hasContent()).toBe(false);
    });

    it('clamps pressure to valid range', () => {
        const manager = new StrokeManager();
        manager.startStroke(10, 10, -5, '#000000', 3);
        manager.addPoint(20, 20, 2.5);
        manager.commitStroke();

        const stroke = manager.getStrokes()[0];
        // Negative pressure → default 0.5
        expect(stroke.points[0].pressure).toBe(0.5);
        // Pressure > 1 → clamped to 1
        expect(stroke.points[1].pressure).toBe(1);
    });

    it('clamps width to 1-8 range', () => {
        const manager = new StrokeManager();
        manager.startStroke(10, 10, 0.5, '#000000', 0);
        manager.commitStroke();
        expect(manager.getStrokes()[0].width).toBe(1);

        manager.startStroke(10, 10, 0.5, '#000000', 15);
        manager.commitStroke();
        expect(manager.getStrokes()[1].width).toBe(8);
    });

    it('tracks bounds correctly as points are added', () => {
        const manager = new StrokeManager();
        manager.startStroke(50, 50, 0.5, '#000000', 3);
        manager.addPoint(10, 80, 0.5);
        manager.addPoint(90, 20, 0.5);
        manager.commitStroke();

        const bounds = manager.getStrokes()[0].bounds;
        expect(bounds.minX).toBe(10);
        expect(bounds.minY).toBe(20);
        expect(bounds.maxX).toBe(90);
        expect(bounds.maxY).toBe(80);
    });

    it('cancelCurrentStroke discards in-progress stroke', () => {
        const manager = new StrokeManager();
        manager.startStroke(10, 10, 0.5, '#000000', 3);
        manager.addPoint(20, 20, 0.5);
        expect(manager.getCurrentStroke()).not.toBeNull();
        expect(manager.hasContent()).toBe(true);

        manager.cancelCurrentStroke();
        expect(manager.getCurrentStroke()).toBeNull();
        expect(manager.hasContent()).toBe(false);
    });

    it('commitStroke clears redo stack', () => {
        const manager = new StrokeManager();
        manager.startStroke(1, 1, 0.5, '#000000', 3);
        manager.commitStroke();
        manager.undo();
        expect(manager.canRedo()).toBe(true);

        manager.startStroke(2, 2, 0.5, '#000000', 3);
        manager.commitStroke();
        expect(manager.canRedo()).toBe(false);
    });

    it('addPoint without startStroke is a no-op', () => {
        const manager = new StrokeManager();
        manager.addPoint(10, 10, 0.5);
        expect(manager.getCurrentStroke()).toBeNull();
        expect(manager.hasContent()).toBe(false);
    });

    it('commitStroke without startStroke returns null', () => {
        const manager = new StrokeManager();
        const result = manager.commitStroke();
        expect(result).toBeNull();
        expect(manager.getStrokes()).toHaveLength(0);
    });
});

