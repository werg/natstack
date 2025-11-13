import type { PanelTabModel } from '../types/panel.types';

interface TabBarProps {
  tabs: PanelTabModel[];
  variant: 'breadcrumbs' | 'siblings' | 'children';
  ariaLabel?: string;
  onSelect: (tab: PanelTabModel) => void;
}

export function TabBar({ tabs, variant, ariaLabel, onSelect }: TabBarProps) {
  if (tabs.length === 0) {
    return null;
  }

  return (
    <div
      className={`panel-tabs panel-tabs--${variant}`}
      role="tablist"
      aria-label={ariaLabel}
    >
      {tabs.map((tab) => (
        <button
          key={`${variant}-${tab.id}`}
          type="button"
          className={`tab tab-${tab.kind}${tab.isActive ? ' active' : ''}`}
          onClick={() => onSelect(tab)}
          aria-current={tab.isActive ? 'page' : undefined}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
