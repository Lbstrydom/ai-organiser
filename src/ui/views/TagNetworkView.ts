import { ItemView, WorkspaceLeaf, Platform } from 'obsidian';
import { NetworkData, NetworkNode, NetworkEdge, TagNetworkManager } from '../../utils/tagNetworkUtils';

export const TAG_NETWORK_VIEW_TYPE = 'tag-network-view';

declare global {
    interface Window {
        d3: any;
    }
}

export class TagNetworkView extends ItemView {
    private networkData: NetworkData;
    private cleanup: (() => void)[] = [];
    private tagNetworkManager: TagNetworkManager;
    private getFiles: () => import('obsidian').TFile[];

    constructor(leaf: WorkspaceLeaf, tagNetworkManager: TagNetworkManager, getFiles: () => import('obsidian').TFile[]) {
        super(leaf);
        this.tagNetworkManager = tagNetworkManager;
        this.getFiles = getFiles;
        this.networkData = tagNetworkManager.getNetworkData();
    }

    getViewType(): string {
        return TAG_NETWORK_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'Tag Network';
    }

    getIcon(): string {
        return 'git-graph';
    }

    /**
     * Update network data and re-render.
     * Called from showTagNetwork() when the leaf already exists.
     */
    public updateNetworkData(data: NetworkData): void {
        this.networkData = data;
        this.render();
    }

    async onOpen(): Promise<void> {
        // When Obsidian restores a persisted leaf, buildTagNetwork() hasn't run yet.
        // Auto-build data so the view doesn't show "No tags found".
        if (this.networkData.nodes.length === 0) {
            await this.tagNetworkManager.buildTagNetwork(this.getFiles());
            this.networkData = this.tagNetworkManager.getNetworkData();
        }
        this.render();
    }

    async onClose(): Promise<void> {
        this.disposeCleanup();
        this.contentEl.empty();
    }

    public async onResize(): Promise<void> {
        if (Platform.isMobile) return;
        this.render();
    }

    // ── Rendering entry point ───────────────────────────────────

    private render(): void {
        this.disposeCleanup();

        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('tag-network-view');

        contentEl.createEl('h2', { text: 'Tag Network Visualization' });
        contentEl.createEl('p', {
            text: 'Node size represents tag frequency. Connections represent tags that appear together in notes.'
        });

        const searchInput = this.buildSearchInput(contentEl);
        this.buildLegend(contentEl);

        const container = contentEl.createDiv({ cls: 'tag-network-container' });
        const tooltip = contentEl.createDiv({ cls: 'tag-tooltip tag-tooltip-hidden' });
        tooltip.createDiv({ cls: 'tag-tooltip-content' });

        const statusEl = contentEl.createDiv({ cls: 'tag-network-status' });

        if (this.networkData.nodes.length === 0) {
            statusEl.setText('No tags found in your vault. Add some tags first!');
            return;
        }

        if (Platform.isMobile) {
            statusEl.setText('');
            this.renderMobileList(container, searchInput, statusEl);
            return;
        }

        statusEl.setText('Loading visualization...');
        this.loadD3AndRender(container, searchInput, tooltip, statusEl);
    }

    // ── UI building helpers ─────────────────────────────────────

    private buildSearchInput(parent: HTMLElement): HTMLInputElement {
        const controlsContainer = parent.createDiv({ cls: 'tag-network-controls' });
        const searchContainer = controlsContainer.createDiv({ cls: 'tag-network-search' });
        searchContainer.createEl('span', { text: 'Search tags: ' });
        return searchContainer.createEl('input', {
            type: 'text',
            placeholder: 'Type to search...',
            cls: 'tag-network-search-input'
        });
    }

    private buildLegend(parent: HTMLElement): void {
        const legendContainer = parent.createDiv({ cls: 'tag-network-legend' });
        legendContainer.createEl('span', { text: 'Frequency: ' });

        for (const label of ['Low', 'Medium', 'High']) {
            const item = legendContainer.createDiv({ cls: 'tag-network-legend-item' });
            item.createDiv({ cls: `tag-network-legend-color ${label.toLowerCase()}` });
            item.createEl('span', { text: label });
        }
    }

    // ── D3 loading & rendering ──────────────────────────────────

    private async loadD3AndRender(
        container: HTMLElement,
        searchInput: HTMLInputElement,
        tooltip: HTMLElement,
        statusEl: HTMLElement
    ): Promise<void> {
        try {
            if (!window.d3) {
                await this.loadD3Script();
            }
            this.renderD3Network(container, searchInput, tooltip, statusEl);
        } catch {
            statusEl.setText('Failed to load visualization library. Please check your internet connection.');
        }
    }

    private loadD3Script(): Promise<void> {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://d3js.org/d3.v7.min.js';
            script.async = true;

            const handleLoad = () => { cleanup(); resolve(); };
            const handleError = (e: ErrorEvent) => { cleanup(); reject(e); };
            const cleanup = () => {
                script.removeEventListener('load', handleLoad);
                script.removeEventListener('error', handleError);
            };

            script.addEventListener('load', handleLoad);
            script.addEventListener('error', handleError);
            document.head.appendChild(script);

            this.cleanup.push(() => { cleanup(); script.remove(); });
        });
    }

    private renderD3Network(
        container: HTMLElement,
        searchInput: HTMLInputElement,
        tooltip: HTMLElement,
        statusEl: HTMLElement
    ): void {
        const d3 = window.d3;
        if (!d3) {
            statusEl.setText('Error: D3.js library not loaded');
            return;
        }

        statusEl.setText('Rendering network...');
        container.empty();

        const width = container.clientWidth || 800;
        const height = container.clientHeight || 600;

        const svg = d3.select(container).append('svg')
            .attr('width', width)
            .attr('height', height)
            .attr('viewBox', [0, 0, width, height])
            .attr('class', 'tag-network-svg');

        const g = svg.append('g');

        const zoom = d3.zoom()
            .scaleExtent([0.1, 8])
            .on('zoom', (event: { transform: any }) => {
                g.attr('transform', event.transform);
            });
        svg.call(zoom);

        const nodes = this.networkData.nodes.map(n => ({
            ...n, x: undefined, y: undefined, fx: undefined, fy: undefined
        }));
        const links = this.networkData.edges.map(e => ({
            source: e.source, target: e.target, weight: e.weight
        }));

        const simulation = d3.forceSimulation(nodes)
            .force('link', d3.forceLink(links).id((d: NetworkNode) => d.id).distance(100))
            .force('charge', d3.forceManyBody().strength(-300))
            .force('center', d3.forceCenter(width / 2, height / 2))
            .force('collision', d3.forceCollide().radius((d: NetworkNode) => d.size + 5));

        const link = g.append('g')
            .attr('class', 'tag-network-link')
            .selectAll('line')
            .data(links)
            .join('line')
            .attr('stroke-width', (d: NetworkEdge) => Math.sqrt(d.weight));

        const node = g.append('g')
            .selectAll('circle')
            .data(nodes)
            .join('circle')
            .attr('class', 'tag-network-node')
            .attr('r', (d: NetworkNode) => d.size)
            .attr('fill', (d: NetworkNode) => this.getNodeColor(d.frequency))
            .call(this.createDrag(d3, simulation));

        const labels = g.append('g')
            .selectAll('text')
            .data(nodes)
            .join('text')
            .attr('class', 'tag-network-label')
            .text((d: NetworkNode) => d.label)
            .attr('dx', (d: NetworkNode) => d.size + 5)
            .attr('dy', 4);

        // ── Hover ──
        node.on('mouseover', (event: MouseEvent, d: NetworkNode) => {
            node.attr('opacity', (n: NetworkNode) => {
                const connected = links.some((l: any) =>
                    (l.source.id === d.id && l.target.id === n.id) ||
                    (l.target.id === d.id && l.source.id === n.id)
                );
                return n === d || connected ? 1 : 0.2;
            });
            link.attr('stroke-opacity', (l: any) =>
                l.source.id === d.id || l.target.id === d.id ? 1 : 0.1
            );

            tooltip.addClass('visible');
            tooltip.style.left = `${event.pageX + 5}px`;
            tooltip.style.top = `${event.pageY + 5}px`;

            const content = tooltip.querySelector('.tag-tooltip-content');
            if (content) {
                const connectionCount = links.filter((l: any) =>
                    l.source.id === d.id || l.target.id === d.id
                ).length;
                content.innerHTML = `
                    <div class="tag-tooltip-title">${d.label}</div>
                    <div class="tag-tooltip-info">Frequency: ${d.frequency}</div>
                    <div class="tag-tooltip-info">Connected to ${connectionCount} other tags</div>
                `;
            }
        }).on('mouseout', () => {
            node.attr('opacity', 1);
            link.attr('stroke-opacity', 0.6);
            tooltip.removeClass('visible');
        });

        // ── Search with zoom-to-fit ──
        const handleSearch = () => {
            const term = searchInput.value.toLowerCase();

            if (term.length > 0) {
                const matches = (d: NetworkNode) => d.label.toLowerCase().includes(term);

                node.attr('opacity', (d: NetworkNode) => matches(d) ? 1 : 0.2);
                labels.attr('opacity', (d: NetworkNode) => matches(d) ? 1 : 0.2);
                link.attr('stroke-opacity', (l: any) =>
                    matches(l.source) && matches(l.target) ? 1 : 0.1
                );

                // Zoom/pan to center on matching nodes
                const matchingNodes = nodes.filter((n: any) =>
                    matches(n) && n.x != null && n.y != null
                );
                if (matchingNodes.length > 0) {
                    this.zoomToNodes(svg, zoom, d3, matchingNodes, width, height);
                }
            } else {
                node.attr('opacity', 1);
                labels.attr('opacity', 1);
                link.attr('stroke-opacity', 0.6);
                svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity);
            }
        };

        searchInput.addEventListener('input', handleSearch);
        this.cleanup.push(() => searchInput.removeEventListener('input', handleSearch));

        // ── Tick ──
        simulation.on('tick', () => {
            link
                .attr('x1', (d: any) => d.source.x)
                .attr('y1', (d: any) => d.source.y)
                .attr('x2', (d: any) => d.target.x)
                .attr('y2', (d: any) => d.target.y);
            node
                .attr('cx', (d: any) => d.x)
                .attr('cy', (d: any) => d.y);
            labels
                .attr('x', (d: any) => d.x)
                .attr('y', (d: any) => d.y);
        });

        this.cleanup.push(() => simulation.stop());
        statusEl.style.display = 'none';
    }

    // ── Zoom helper ─────────────────────────────────────────────

    private zoomToNodes(svg: any, zoom: any, d3: any, matchingNodes: any[], width: number, height: number): void {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const n of matchingNodes) {
            minX = Math.min(minX, n.x);
            maxX = Math.max(maxX, n.x);
            minY = Math.min(minY, n.y);
            maxY = Math.max(maxY, n.y);
        }
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const padding = 80;
        const bboxW = maxX - minX + padding * 2;
        const bboxH = maxY - minY + padding * 2;
        const scale = Math.min(2, Math.max(0.5, Math.min(width / bboxW, height / bboxH)));
        const tx = width / 2 - cx * scale;
        const ty = height / 2 - cy * scale;
        svg.transition().duration(400).call(
            zoom.transform,
            d3.zoomIdentity.translate(tx, ty).scale(scale)
        );
    }

    // ── Mobile list rendering ───────────────────────────────────

    private renderMobileList(container: HTMLElement, searchInput: HTMLInputElement, statusEl: HTMLElement): void {
        container.empty();
        const listEl = container.createEl('ul', { cls: 'tag-network-list' });

        const connectionCounts = new Map<string, number>();
        for (const edge of this.networkData.edges) {
            connectionCounts.set(edge.source, (connectionCounts.get(edge.source) || 0) + 1);
            connectionCounts.set(edge.target, (connectionCounts.get(edge.target) || 0) + 1);
        }

        const nodes = [...this.networkData.nodes].sort((a, b) => b.frequency - a.frequency);

        const renderList = () => {
            const term = searchInput.value.trim().toLowerCase();
            listEl.empty();

            const filtered = term
                ? nodes.filter(n => n.label.toLowerCase().includes(term))
                : nodes;

            if (filtered.length === 0) {
                statusEl.setText('No matching tags');
                return;
            }

            statusEl.setText('');
            for (const n of filtered) {
                const itemEl = listEl.createEl('li', { cls: 'tag-network-list-item' });
                const button = itemEl.createEl('button', {
                    cls: 'tag-network-list-button',
                    text: `#${n.label}`
                });
                button.addEventListener('click', async () => {
                    const leaf = this.app.workspace.getLeaf('tab');
                    if (leaf) {
                        await leaf.setViewState({
                            type: 'search',
                            state: { query: `tag:#${n.label}` },
                            active: true
                        });
                        this.app.workspace.revealLeaf(leaf);
                    }
                });

                const connectionCount = connectionCounts.get(n.id) || 0;
                itemEl.createEl('small', {
                    cls: 'tag-network-list-meta',
                    text: `Frequency: ${n.frequency} · Connections: ${connectionCount}`
                });
            }
        };

        searchInput.addEventListener('input', renderList);
        this.cleanup.push(() => searchInput.removeEventListener('input', renderList));
        renderList();
    }

    // ── Utilities ───────────────────────────────────────────────

    private createDrag(d3: any, simulation: any): any {
        return d3.drag()
            .on('start', (event: any) => {
                if (!event.active) simulation.alphaTarget(0.3).restart();
                event.subject.fx = event.subject.x;
                event.subject.fy = event.subject.y;
            })
            .on('drag', (event: any) => {
                event.subject.fx = event.x;
                event.subject.fy = event.y;
            })
            .on('end', (event: any) => {
                if (!event.active) simulation.alphaTarget(0);
                event.subject.fx = null;
                event.subject.fy = null;
            });
    }

    private getNodeColor(frequency: number): string {
        const maxFreq = Math.max(...this.networkData.nodes.map(n => n.frequency));
        const normalizedFreq = maxFreq > 1 ? (frequency - 1) / (maxFreq - 1) : 0;

        const r = Math.floor(100 - normalizedFreq * 100);
        const g = Math.floor(149 - normalizedFreq * 100);
        const b = Math.floor(237 - normalizedFreq * 50);

        return `rgba(${r}, ${g}, ${b}, 1)`;
    }

    private disposeCleanup(): void {
        this.cleanup.forEach(fn => fn());
        this.cleanup = [];
    }
}
