/**
 * Panel Web Component
 * A single panel in the stackable panel system
 */

import type { PanelId, PanelNode, PanelVisibility } from '../types/panel.types';

export class Panel extends HTMLElement {
  private panelId: PanelId;
  private headerElement: HTMLElement;
  private titleElement: HTMLElement;
  private contentElement: HTMLElement;
  private actionsElement: HTMLElement;
  private visibility: PanelVisibility = 'expanded';

  constructor(panelId: PanelId, node: PanelNode) {
    super();
    this.panelId = panelId;

    // Set class and data attributes
    this.className = 'panel';
    this.dataset['panelId'] = panelId;

    // Create structure
    this.headerElement = this.createHeader();
    this.titleElement = this.headerElement.querySelector('.panel-title') as HTMLElement;
    this.actionsElement = this.headerElement.querySelector('.panel-actions') as HTMLElement;
    this.contentElement = this.createContent();

    // Append elements
    this.appendChild(this.headerElement);
    this.appendChild(this.contentElement);

    // Set initial title
    this.setTitle(node.title);
  }

  /**
   * Create the panel header
   */
  private createHeader(): HTMLElement {
    const header = document.createElement('div');
    header.className = 'panel-header';

    const title = document.createElement('h2');
    title.className = 'panel-title';

    const actions = document.createElement('div');
    actions.className = 'panel-actions';

    header.appendChild(title);
    header.appendChild(actions);

    return header;
  }

  /**
   * Create the panel content area
   */
  private createContent(): HTMLElement {
    const content = document.createElement('div');
    content.className = 'panel-content';
    return content;
  }

  /**
   * Get the panel ID
   */
  getPanelId(): PanelId {
    return this.panelId;
  }

  /**
   * Set the panel title
   */
  setTitle(title: string): void {
    this.titleElement.textContent = title;
  }

  /**
   * Get the content element for adding content
   */
  getContentElement(): HTMLElement {
    return this.contentElement;
  }

  /**
   * Get the actions element for adding buttons
   */
  getActionsElement(): HTMLElement {
    return this.actionsElement;
  }

  /**
   * Set the panel visibility state
   */
  setVisibility(visibility: PanelVisibility): void {
    this.visibility = visibility;

    // Remove all visibility classes
    this.classList.remove('expanded', 'collapsing', 'collapsed', 'hidden');

    // Add current visibility class
    this.classList.add(visibility);

    // Update ARIA attributes
    if (visibility === 'collapsed' || visibility === 'hidden') {
      this.contentElement.setAttribute('aria-hidden', 'true');
    } else {
      this.contentElement.removeAttribute('aria-hidden');
    }
  }

  /**
   * Get the current visibility state
   */
  getVisibility(): PanelVisibility {
    return this.visibility;
  }

  /**
   * Set focus state
   */
  setFocused(focused: boolean): void {
    if (focused) {
      this.classList.add('focused');
      this.setAttribute('data-focused', 'true');
    } else {
      this.classList.remove('focused');
      this.removeAttribute('data-focused');
    }
  }

  /**
   * Set active state (in active path)
   */
  setActive(active: boolean): void {
    if (active) {
      this.classList.add('active');
      this.setAttribute('data-active', 'true');
    } else {
      this.classList.remove('active');
      this.removeAttribute('data-active');
    }
  }

  /**
   * Set width (percentage)
   */
  setWidth(widthPercent: number): void {
    this.style.width = `${widthPercent}%`;
    this.style.flexShrink = '0';
    this.style.flexGrow = '0';
  }

  /**
   * Collapse the panel with animation
   */
  async collapse(): Promise<void> {
    this.setVisibility('collapsing');

    // Wait for animation
    await new Promise((resolve) => setTimeout(resolve, 400));

    this.setVisibility('collapsed');
  }

  /**
   * Expand the panel with animation
   */
  async expand(): Promise<void> {
    this.setVisibility('expanded');
  }

  /**
   * Add action button to header
   */
  addActionButton(label: string, onClick: () => void, className = ''): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = `button button-ghost button-icon ${className}`;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.textContent = label.substring(0, 1); // First letter as icon placeholder

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });

    this.actionsElement.appendChild(button);
    return button;
  }

  /**
   * Clear all content
   */
  clearContent(): void {
    this.contentElement.innerHTML = '';
  }

  /**
   * Set content HTML
   */
  setContent(html: string): void {
    this.contentElement.innerHTML = html;
  }

  /**
   * Append child element to content
   */
  appendContent(element: HTMLElement): void {
    this.contentElement.appendChild(element);
  }

  /**
   * Focus the panel
   */
  focus(): void {
    this.setFocused(true);
    this.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
  }

  /**
   * Blur the panel
   */
  blur(): void {
    this.setFocused(false);
  }
}

// Register the custom element
customElements.define('app-panel', Panel);
