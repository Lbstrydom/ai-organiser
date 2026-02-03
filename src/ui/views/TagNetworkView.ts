import { ItemView, WorkspaceLeaf, Platform } from 'obsidian';
import { NetworkData, NetworkNode, NetworkEdge, TagNetworkManager } from '../../utils/tagNetworkUtils';
import type AIOrganiserPlugin from '../../main';

export const TAG_NETWORK_VIEW_TYPE = 'tag-network-view';

const OPACITY_SELECTED = 1;
const OPACITY_NEIGHBOR = 0.7;
const OPACITY_FADED = 0.15;
const EDGE_OPACITY_BOTH_SELECTED = 1;
const EDGE_OPACITY_ONE_SELECTED = 0.5;
const EDGE_OPACITY_NONE = 0.05;
const EDGE_OPACITY_DEFAULT = 0.6;

export interface TagSuggestion {
    id: string;
    label: string;
    frequency: number;
}

export function filterSuggestions(
    allNodes: NetworkNode[],
    term: string,
    selectedIds: Set<string>,
    maxResults?: number
): TagSuggestion[] {
    const trimmedTerm = term.trim().toLowerCase();
    if (!trimmedTerm) return [];

    const sorted = allNodes
        .filter(n => !selectedIds.has(n.id) && n.label.toLowerCase().includes(trimmedTerm))
        .sort((a, b) => b.frequency - a.frequency);
    const sliced = maxResults == null ? sorted : sorted.slice(0, maxResults);
    return sliced.map(n => ({ id: n.id, label: n.label, frequency: n.frequency }));
}

export function computeFilterSets(
    selectedIds: Set<string>,
    edges: NetworkEdge[]
): { neighborSet: Set<string> } {
    const neighborSet = new Set<string>();
    for (const edge of edges) {
        if (selectedIds.has(edge.source)) neighborSet.add(edge.target);
        if (selectedIds.has(edge.target)) neighborSet.add(edge.source);
    }
    for (const id of selectedIds) neighborSet.delete(id);
    return { neighborSet };
}

interface TagSearchState {
    container: HTMLElement;
    input: HTMLInputElement;
    dropdown: HTMLElement;
    selectedIds: Set<string>;
    selectedOrder: string[];
    activeIndex: number;
    suggestions: TagSuggestion[];
}

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
    private plugin: AIOrganiserPlugin;

    constructor(
        leaf: WorkspaceLeaf,
        tagNetworkManager: TagNetworkManager,
        getFiles: () => import('obsidian').TFile[],
        plugin: AIOrganiserPlugin
    ) {
        super(leaf);
        this.tagNetworkManager = tagNetworkManager;
        this.getFiles = getFiles;
        this.plugin = plugin;
        this.networkData = tagNetworkManager.getNetworkData();
    }

    getViewType(): string {
        return TAG_NETWORK_VIEW_TYPE;
    }

    getDisplayText(): string {
        return this.plugin.t.tagNetwork.title;
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

        const t = this.plugin.t.tagNetwork;
        contentEl.createEl('h2', { text: t.title });
        contentEl.createEl('p', { text: t.description });

        let onSelectionChange = () => {};
        const searchState = this.buildTagSearchInput(contentEl, this.networkData.nodes, () => onSelectionChange());
        this.buildLegend(contentEl);

        const container = contentEl.createDiv({ cls: 'tag-network-container' });
        const tooltip = contentEl.createDiv({ cls: 'tag-tooltip tag-tooltip-hidden' });
        tooltip.createDiv({ cls: 'tag-tooltip-content' });

        const statusEl = contentEl.createDiv({ cls: 'tag-network-status' });

        if (this.networkData.nodes.length === 0) {
            statusEl.setText(t.noTagsFound);
            return;
        }

        if (Platform.isMobile) {
            statusEl.setText('');
            onSelectionChange = this.renderMobileList(container, searchState, statusEl);
            return;
        }

        statusEl.setText(t.loadingVisualization);
        this.loadD3AndRender(container, searchState, tooltip, statusEl, (handler) => { onSelectionChange = handler; });
    }

    // ── UI building helpers ─────────────────────────────────────

    private buildTagSearchInput(
        parent: HTMLElement,
        nodes: NetworkNode[],
        onSelectionChange: () => void
    ): TagSearchState {
        const t = this.plugin.t.tagNetwork;
        const controlsContainer = parent.createDiv({ cls: 'tag-network-controls' });
        const searchContainer = controlsContainer.createDiv({ cls: 'tag-network-search' });
        const chipContainer = searchContainer.createDiv({ cls: 'tag-network-chip-container' });
        const input = chipContainer.createEl('input', {
            type: 'text',
            placeholder: t.searchPlaceholder,
            cls: 'tag-network-search-input'
        });
        input.setAttr('aria-label', t.searchPlaceholder);

        const dropdown = searchContainer.createDiv({ cls: 'tag-network-dropdown' });
        dropdown.style.display = 'none';

        const nodeById = new Map(nodes.map(node => [node.id, node]));
        const selectedIds = new Set<string>();
        const selectedOrder: string[] = [];

        const state: TagSearchState = {
            container: searchContainer,
            input,
            dropdown,
            selectedIds,
            selectedOrder,
            activeIndex: -1,
            suggestions: []
        };

        const hideDropdown = () => {
            dropdown.style.display = 'none';
            dropdown.empty();
        };

        const renderDropdown = (activeIndex: number) => {
            const suggestions = filterSuggestions(nodes, input.value, selectedIds);
            dropdown.empty();

            if (suggestions.length === 0) {
                if (input.value.trim().length > 0) {
                    const emptyItem = dropdown.createDiv({ cls: 'tag-network-dropdown-item tag-network-dropdown-empty' });
                    emptyItem.setText(t.noMatchingTags);
                    dropdown.style.display = 'block';
                } else {
                    hideDropdown();
                }
                return { suggestions, activeIndex: -1 };
            }

            suggestions.forEach((suggestion, index) => {
                const item = dropdown.createDiv({
                    cls: `tag-network-dropdown-item${index === activeIndex ? ' active' : ''}`
                });
                item.setAttr('data-id', suggestion.id);
                item.createDiv({ text: suggestion.label });
                item.createDiv({ cls: 'tag-network-dropdown-freq', text: String(suggestion.frequency) });
                item.addEventListener('click', () => {
                    addChip(suggestion.id);
                    hideDropdown();
                });
            });

            dropdown.style.display = 'block';
            return { suggestions, activeIndex: Math.max(0, Math.min(activeIndex, suggestions.length - 1)) };
        };

        const addChip = (id: string) => {
            if (selectedIds.has(id)) return;
            const node = nodeById.get(id);
            if (!node) return;

            selectedIds.add(id);
            selectedOrder.push(id);

            const chip = chipContainer.createDiv({ cls: 'tag-network-chip' });
            chip.dataset.chipId = id;
            chip.createDiv({ cls: 'tag-network-chip-label', text: node.label });
            const removeButton = chip.createEl('button', { cls: 'tag-network-chip-remove', text: '×' });
            removeButton.setAttr('aria-label', `Remove ${node.label}`);
            removeButton.setAttr('type', 'button');
            removeButton.addEventListener('click', () => removeChip(id));

            input.value = '';
            hideDropdown();
            onSelectionChange();
            input.focus();
        };

        const removeChip = (id: string) => {
            if (!selectedIds.has(id)) return;
            selectedIds.delete(id);
            const index = selectedOrder.indexOf(id);
            if (index >= 0) selectedOrder.splice(index, 1);

            const chip = chipContainer.querySelector(`[data-chip-id="${id}"]`) as HTMLElement | null;
            if (chip) {
                chip.remove();
            } else {
                for (const child of Array.from(chipContainer.children)) {
                    if (child instanceof HTMLElement && child.dataset.chipId === id) {
                        child.remove();
                        break;
                    }
                }
            }
            onSelectionChange();
            input.focus();
        };

        const onInput = () => {
            const { suggestions, activeIndex } = renderDropdown(0);
            state.suggestions = suggestions;
            state.activeIndex = activeIndex;
        };

        const onKeydown = (event: KeyboardEvent) => {
            if (event.key === 'Backspace' && input.value.length === 0 && selectedOrder.length > 0) {
                removeChip(selectedOrder[selectedOrder.length - 1]);
                return;
            }

            if (dropdown.style.display !== 'block') return;
            if (state.suggestions.length === 0) return;

            if (event.key === 'ArrowDown') {
                event.preventDefault();
                state.activeIndex = (state.activeIndex + 1) % state.suggestions.length;
                const { suggestions, activeIndex } = renderDropdown(state.activeIndex);
                state.suggestions = suggestions;
                state.activeIndex = activeIndex;
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                state.activeIndex = (state.activeIndex - 1 + state.suggestions.length) % state.suggestions.length;
                const { suggestions, activeIndex } = renderDropdown(state.activeIndex);
                state.suggestions = suggestions;
                state.activeIndex = activeIndex;
            } else if (event.key === 'Enter') {
                event.preventDefault();
                const suggestion = state.suggestions[state.activeIndex];
                if (suggestion) {
                    addChip(suggestion.id);
                }
                hideDropdown();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                hideDropdown();
            }
        };

        const onClickOutside = (event: MouseEvent) => {
            if (!searchContainer.contains(event.target as Node)) {
                hideDropdown();
            }
        };

        const onContainerClick = () => input.focus();

        const onFocus = () => {
            if (input.value.trim().length > 0) {
                const { suggestions, activeIndex } = renderDropdown(0);
                state.suggestions = suggestions;
                state.activeIndex = activeIndex;
            }
        };

        input.addEventListener('input', onInput);
        input.addEventListener('keydown', onKeydown);
        input.addEventListener('focus', onFocus);
        chipContainer.addEventListener('click', onContainerClick);
        document.addEventListener('click', onClickOutside);

        this.cleanup.push(() => {
            input.removeEventListener('input', onInput);
            input.removeEventListener('keydown', onKeydown);
            input.removeEventListener('focus', onFocus);
            chipContainer.removeEventListener('click', onContainerClick);
            document.removeEventListener('click', onClickOutside);
        });

        return state;
    }

    private buildLegend(parent: HTMLElement): void {
        const t = this.plugin.t.tagNetwork;
        const legendContainer = parent.createDiv({ cls: 'tag-network-legend' });
        legendContainer.createEl('span', { text: t.legendFrequency });

        const legendItems = [
            { key: 'low', label: t.legendLow },
            { key: 'medium', label: t.legendMedium },
            { key: 'high', label: t.legendHigh }
        ];

        for (const itemData of legendItems) {
            const item = legendContainer.createDiv({ cls: 'tag-network-legend-item' });
            item.createDiv({ cls: `tag-network-legend-color ${itemData.key}` });
            item.createEl('span', { text: itemData.label });
        }
    }

    // ── D3 loading & rendering ──────────────────────────────────

    private async loadD3AndRender(
        container: HTMLElement,
        searchState: TagSearchState,
        tooltip: HTMLElement,
        statusEl: HTMLElement,
        onSearchHandlerReady: (handler: () => void) => void
    ): Promise<void> {
        const t = this.plugin.t.tagNetwork;
        try {
            if (!window.d3) {
                await this.loadD3Script();
            }
            const handler = this.renderD3Network(container, searchState, tooltip, statusEl);
            onSearchHandlerReady(handler);
        } catch {
            statusEl.setText(t.loadFailed);
        }
    }

    private loadD3Script(): Promise<void> {
        const cdnUrls = [
            'https://d3js.org/d3.v7.min.js',
            'https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js',
            'https://unpkg.com/d3@7/dist/d3.min.js'
        ];

        return this.tryLoadFromCDN(cdnUrls, 0);
    }

    private tryLoadFromCDN(cdnUrls: string[], index: number): Promise<void> {
        if (index >= cdnUrls.length) {
            return Promise.reject(new Error('All CDN attempts failed'));
        }

        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = cdnUrls[index];
            script.async = true;

            const handleLoad = () => { cleanup(); resolve(); };
            const handleError = () => { 
                cleanup(); 
                // Try next CDN
                this.tryLoadFromCDN(cdnUrls, index + 1)
                    .then(resolve)
                    .catch(reject);
            };
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
        searchState: TagSearchState,
        tooltip: HTMLElement,
        statusEl: HTMLElement
    ): () => void {
        const t = this.plugin.t.tagNetwork;
        const d3 = window.d3;
        if (!d3) {
            statusEl.setText(t.loadFailed);
            return () => {};
        }

        statusEl.setText(t.loadingVisualization);
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
        const getId = (value: any) => (typeof value === 'string' ? value : value.id);

        let filterState: { selectedSet: Set<string>; neighborSet: Set<string> } | null = null;

        const applyFilterState = () => {
            if (!filterState) {
                node.attr('opacity', OPACITY_SELECTED)
                    .attr('stroke', null)
                    .attr('stroke-width', null);
                labels.attr('opacity', OPACITY_SELECTED);
                link.attr('stroke-opacity', EDGE_OPACITY_DEFAULT)
                    .attr('stroke-width', (d: NetworkEdge) => Math.sqrt(d.weight));
                return;
            }

            const { selectedSet, neighborSet } = filterState;
            node.attr('opacity', (d: NetworkNode) =>
                selectedSet.has(d.id) ? OPACITY_SELECTED : neighborSet.has(d.id) ? OPACITY_NEIGHBOR : OPACITY_FADED
            ).attr('stroke', (d: NetworkNode) =>
                selectedSet.has(d.id) ? 'var(--interactive-accent)' : null
            ).attr('stroke-width', (d: NetworkNode) =>
                selectedSet.has(d.id) ? 2 : null
            );
            labels.attr('opacity', (d: NetworkNode) =>
                selectedSet.has(d.id) ? OPACITY_SELECTED : neighborSet.has(d.id) ? OPACITY_NEIGHBOR : OPACITY_FADED
            );
            link.attr('stroke-opacity', (l: any) => {
                const srcSelected = selectedSet.has(getId(l.source));
                const tgtSelected = selectedSet.has(getId(l.target));
                if (srcSelected && tgtSelected) return EDGE_OPACITY_BOTH_SELECTED;
                if (srcSelected || tgtSelected) return EDGE_OPACITY_ONE_SELECTED;
                return EDGE_OPACITY_NONE;
            }).attr('stroke-width', (l: any) => {
                const srcSelected = selectedSet.has(getId(l.source));
                const tgtSelected = selectedSet.has(getId(l.target));
                const baseWidth = Math.sqrt(l.weight);
                return (srcSelected && tgtSelected) ? baseWidth + 2 : baseWidth;
            });
        };

        node.on('mouseover', (event: MouseEvent, d: NetworkNode) => {
            node.attr('opacity', (n: NetworkNode) => {
                const connected = links.some((l: any) =>
                    (getId(l.source) === d.id && getId(l.target) === n.id) ||
                    (getId(l.target) === d.id && getId(l.source) === n.id)
                );
                return n === d || connected ? OPACITY_SELECTED : OPACITY_FADED;
            });
            labels.attr('opacity', (n: NetworkNode) => {
                const connected = links.some((l: any) =>
                    (getId(l.source) === d.id && getId(l.target) === n.id) ||
                    (getId(l.target) === d.id && getId(l.source) === n.id)
                );
                return n === d || connected ? OPACITY_SELECTED : OPACITY_FADED;
            });
            link.attr('stroke-opacity', (l: any) =>
                getId(l.source) === d.id || getId(l.target) === d.id ? EDGE_OPACITY_BOTH_SELECTED : EDGE_OPACITY_NONE
            );

            tooltip.addClass('visible');
            tooltip.style.left = `${event.pageX + 5}px`;
            tooltip.style.top = `${event.pageY + 5}px`;

            const content = tooltip.querySelector('.tag-tooltip-content');
            if (content) {
                const connectionCount = links.filter((l: any) =>
                    getId(l.source) === d.id || getId(l.target) === d.id
                ).length;
                const connectionText = t.tooltipConnections.replace('{count}', String(connectionCount));
                content.innerHTML = `
                    <div class="tag-tooltip-title">${d.label}</div>
                    <div class="tag-tooltip-info">${t.tooltipFrequency}: ${d.frequency}</div>
                    <div class="tag-tooltip-info">${connectionText}</div>
                `;
            }
        }).on('mouseout', () => {
            applyFilterState();
            tooltip.removeClass('visible');
        });

        // ── Search with zoom-to-fit ──
        const handleSearch = () => {
            const selectedSet = new Set(searchState.selectedIds);
            if (selectedSet.size === 0) {
                filterState = null;
                applyFilterState();
                svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity);
                return;
            }

            const { neighborSet } = computeFilterSets(selectedSet, this.networkData.edges);
            filterState = { selectedSet, neighborSet };
            applyFilterState();

            const matchingNodes = nodes.filter(n => selectedSet.has(n.id) && n.x != null && n.y != null);
            if (matchingNodes.length > 0) {
                this.zoomToNodes(svg, zoom, d3, matchingNodes, width, height);
            }
        };

        handleSearch();

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
        return handleSearch;
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

    private renderMobileList(container: HTMLElement, searchState: TagSearchState, statusEl: HTMLElement): () => void {
        const t = this.plugin.t.tagNetwork;
        container.empty();
        const listEl = container.createEl('ul', { cls: 'tag-network-list' });

        const connectionCounts = new Map<string, number>();
        for (const edge of this.networkData.edges) {
            connectionCounts.set(edge.source, (connectionCounts.get(edge.source) || 0) + 1);
            connectionCounts.set(edge.target, (connectionCounts.get(edge.target) || 0) + 1);
        }

        const nodes = [...this.networkData.nodes].sort((a, b) => b.frequency - a.frequency);
        const nodeById = new Map(nodes.map(node => [node.id, node]));

        const renderList = () => {
            listEl.empty();

            const selectedIds = new Set(searchState.selectedIds);
            const neighborSet = selectedIds.size > 0
                ? computeFilterSets(selectedIds, this.networkData.edges).neighborSet
                : null;
            const filtered = neighborSet
                ? nodes.filter(n => selectedIds.has(n.id) || neighborSet.has(n.id))
                : nodes;

            if (filtered.length === 0) {
                statusEl.setText(t.noMatchingTags);
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
                    text: `${t.tooltipFrequency}: ${n.frequency} · ${t.tooltipConnections.replace('{count}', String(connectionCount))}`
                });

                if (searchState.selectedIds.size > 0) {
                    const coOccurring = this.networkData.edges
                        .filter(edge =>
                            (edge.source === n.id && searchState.selectedIds.has(edge.target)) ||
                            (edge.target === n.id && searchState.selectedIds.has(edge.source))
                        )
                        .map(edge => edge.source === n.id ? edge.target : edge.source)
                        .map(id => nodeById.get(id)?.label)
                        .filter((label): label is string => Boolean(label));

                    if (coOccurring.length > 0) {
                        itemEl.createEl('small', {
                            cls: 'tag-network-list-meta',
                            text: `${t.coOccurringTags}: ${coOccurring.join(', ')}`
                        });
                    }
                }
            }
        };
        renderList();
        return renderList;
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
