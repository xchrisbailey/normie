// The app's line icons, drawn at 24 units and sized by CSS. Decorative: each sits beside, or inside, a named control.
import type { ReactNode } from 'react';

const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const MailIcon = () => (
  <Icon>
    <rect x="3" y="5" width="18" height="14" rx="3" {...S} />
    <path d="M4 7l8 6 8-6" {...S} />
  </Icon>
);
export const SettingsIcon = () => (
  <Icon>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" {...S} />
    <circle cx="15" cy="7" r="2" {...S} />
    <circle cx="9" cy="17" r="2" {...S} />
  </Icon>
);
export const SearchIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="6.5" {...S} />
    <path d="M16 16l4.5 4.5" {...S} />
  </Icon>
);
export const ComposeIcon = () => (
  <Icon>
    <path d="M4 20l1-4.5L15.5 5a2.1 2.1 0 013 3L8 18.5z" {...S} />
    <path d="M13.5 7l3 3" {...S} />
  </Icon>
);
export const MoreIcon = () => (
  <Icon>
    <path d="M6 12h.01M12 12h.01M18 12h.01" {...S} strokeWidth={2.6} />
  </Icon>
);
/** The Done key, large: a keycap with a check, for the calm empty states. */
export const DoneMark = () => (
  <svg className="done-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <rect x="6" y="6" width="52" height="52" rx="14" fill="none" stroke="currentColor" strokeWidth="2.5" />
    <path d="M14 46h36" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.35" />
    <path d="M21 29l8 8 14-15" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const DoneIcon = () => (
  <Icon>
    <path d="M5 12.5l4.5 4.5L19 7.5" {...S} strokeWidth={1.8} />
  </Icon>
);
export const SnoozeIcon = () => (
  <Icon>
    <circle cx="12" cy="13" r="7.5" {...S} />
    <path d="M12 9v4.5l3 2" {...S} />
  </Icon>
);
export const ReplyIcon = () => (
  <Icon>
    <path d="M10 6L4 12l6 6M4.5 12H14a6 6 0 016 6v1" {...S} />
  </Icon>
);
export const BackIcon = () => (
  <Icon>
    <path d="M14.5 6l-6 6 6 6" {...S} strokeWidth={1.8} />
  </Icon>
);

const AllIcon = () => (
  <Icon>
    <rect x="4" y="9" width="16" height="11" rx="2.5" {...S} />
    <path d="M6.5 6h11M9 3h6" {...S} />
  </Icon>
);
const StarIcon = () => (
  <Icon>
    <path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" {...S} />
  </Icon>
);
const ClockIcon = () => (
  <Icon>
    <circle cx="12" cy="13" r="7.5" {...S} />
    <path d="M12 9v4.5l3 2M4 5l3-2M20 5l-3-2" {...S} />
  </Icon>
);
const NewsIcon = () => (
  <Icon>
    <rect x="3.5" y="4.5" width="14" height="15" rx="2" {...S} />
    <path d="M17.5 9H20v8.5a2 2 0 01-2 2M7 9h7M7 12.5h7M7 16h4" {...S} />
  </Icon>
);
const TrayIcon = () => (
  <Icon>
    <path d="M3.5 13l2.7-7.2A2 2 0 018.1 4.5h7.8a2 2 0 011.9 1.3l2.7 7.2v5a1.5 1.5 0 01-1.5 1.5h-14A1.5 1.5 0 013.5 18z" {...S} />
    <path d="M3.5 13H8l1.5 2.5h5L16 13h4.5" {...S} />
  </Icon>
);
const PersonIcon = () => (
  <Icon>
    <circle cx="12" cy="8.5" r="3.8" {...S} />
    <path d="M4.5 20a7.5 7.5 0 0115 0" {...S} />
  </Icon>
);
const TagIcon = () => (
  <Icon>
    <path d="M3.5 12.2V4.5a1 1 0 011-1h7.7l8.3 8.3a1.4 1.4 0 010 2l-6.7 6.7a1.4 1.4 0 01-2 0z" {...S} />
    <circle cx="8" cy="8" r="1.3" {...S} />
  </Icon>
);

const SPLIT_ICONS = new Map<string, () => ReactNode>([
  ['inbox', AllIcon],
  ['important', StarIcon],
  ['other', TrayIcon],
  ['newsletters', NewsIcon],
  ['vip', PersonIcon],
  ['snoozed', ClockIcon],
]);

/** A Split's icon, and its look for the stylesheet's colors; custom and per-Account Splits share a tag. */
export function splitIcon(id: string) {
  const Draw = SPLIT_ICONS.get(id);
  return Draw ? { icon: <Draw />, look: id } : { icon: <TagIcon />, look: 'custom' };
}
