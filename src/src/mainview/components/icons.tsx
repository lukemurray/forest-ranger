/** Minimal inline icon set (16px, currentColor stroke). */

type Props = { size?: number };

function svg(size: number, children: React.ReactNode) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

export const ChevronIcon = ({ size = 14 }: Props) => svg(size, <path d="m9 18 6-6-6-6" />);

export const PlusIcon = ({ size = 16 }: Props) =>
	svg(size, <><path d="M12 5v14" /><path d="M5 12h14" /></>);

export const ClockIcon = ({ size = 15 }: Props) =>
	svg(size, <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);

export const TreeIcon = ({ size = 16 }: Props) =>
	svg(
		size,
		<>
			<path d="M12 2 4 14h16L12 2Z" />
			<path d="M12 14v8" />
			<path d="M8 9h8" />
		</>,
	);

export const GitBranchIcon = ({ size = 15 }: Props) =>
	svg(
		size,
		<>
			<circle cx="6" cy="6" r="3" />
			<circle cx="6" cy="18" r="3" />
			<circle cx="18" cy="6" r="3" />
			<path d="M6 9v6" />
			<path d="M18 9a9 9 0 0 1-9 9" />
		</>,
	);

export const FolderIcon = ({ size = 15 }: Props) =>
	svg(size, <path d="M4 5h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />);

export const CheckIcon = ({ size = 16 }: Props) =>
	svg(size, <path d="m5 12 5 5L20 7" />);

export const GearIcon = ({ size = 16 }: Props) =>
	svg(
		size,
		<>
			<circle cx="12" cy="12" r="3" />
			<path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
		</>,
	);

export const ChevronUpDownIcon = ({ size = 16 }: Props) =>
	svg(size, <><path d="m8 9 4-4 4 4" /><path d="m16 15-4 4-4-4" /></>);

export const PlayIcon = ({ size = 15 }: Props) =>
	svg(size, <path d="M7 4.5v15l12-7.5-12-7.5Z" />);

export const PencilIcon = ({ size = 15 }: Props) =>
	svg(
		size,
		<>
			<path d="M12 20h9" />
			<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
		</>,
	);

export const TrashIcon = ({ size = 15 }: Props) =>
	svg(
		size,
		<>
			<path d="M4 7h16" />
			<path d="M10 11v6M14 11v6" />
			<path d="M5 7l1 13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-13" />
			<path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
		</>,
	);

export const TerminalIcon = ({ size = 15 }: Props) =>
	svg(
		size,
		<>
			<rect x="3" y="4" width="18" height="16" rx="2" />
			<path d="m7 9 3 3-3 3" />
			<path d="M13 15h4" />
		</>,
	);

export const RevealIcon = ({ size = 15 }: Props) =>
	svg(
		size,
		<>
			<path d="M15 3h6v6" />
			<path d="M10 14 21 3" />
			<path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
		</>,
	);
