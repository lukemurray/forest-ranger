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

export const ChevronDownIcon = ({ size = 14 }: Props) => svg(size, <path d="m6 9 6 6 6-6" />);

export const ArrowLeftIcon = ({ size = 16 }: Props) =>
	svg(
		size,
		<>
			<path d="m12 19-7-7 7-7" />
			<path d="M19 12H5" />
		</>,
	);

export const ArrowRightIcon = ({ size = 16 }: Props) =>
	svg(
		size,
		<>
			<path d="M5 12h14" />
			<path d="m12 5 7 7-7 7" />
		</>,
	);

export const EllipsisIcon = ({ size = 16 }: Props) => (
	<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
		<circle cx="5" cy="12" r="1.6" />
		<circle cx="12" cy="12" r="1.6" />
		<circle cx="19" cy="12" r="1.6" />
	</svg>
);

export const PlusIcon = ({ size = 16 }: Props) =>
	svg(size, <><path d="M12 5v14" /><path d="M5 12h14" /></>);

export const ClockIcon = ({ size = 15 }: Props) =>
	svg(size, <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);

// Size-adaptive brand mark: a clean single pine at icon sizes (where extra tiers
// just clog), a fuller two-tier conifer once it's big enough to carry the detail.
export const TreeIcon = ({ size = 16 }: Props) =>
	size < 24
		? svg(
				size,
				<>
					<path d="M12 2 4 14h16L12 2Z" />
					<path d="M12 14v8" />
					<path d="M8 9h8" />
				</>,
			)
		: svg(
				size,
				<>
					<path d="M12 3 7 11h10z" />
					<path d="M12 9 5 18h14z" />
					<path d="M12 18v3" />
				</>,
			);

// A sprouting seedling — marks the primary worktree (the trunk branches grow from).
export const SproutIcon = ({ size = 14 }: Props) =>
	svg(
		size,
		<>
			<path d="M12 21v-8" />
			<path d="M12 13C8 13 6 10 6 6c4 0 6 3 6 7Z" />
			<path d="M12 13c0-3 2-6 6-6 0 4-2 6-6 6Z" />
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

export const FileIcon = ({ size = 15 }: Props) =>
	svg(
		size,
		<>
			<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
			<path d="M14 2v6h6" />
		</>,
	);

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

export const DownloadIcon = ({ size = 15 }: Props) =>
	svg(size, <><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M5 21h14" /></>);

export const RefreshIcon = ({ size = 15 }: Props) =>
	svg(size, <><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 4v5h-5" /></>);

export const SparkleIcon = ({ size = 15 }: Props) =>
	svg(
		size,
		<>
			<path d="M12 3l1.6 4.6L18 9.2l-4.4 1.6L12 15l-1.6-4.2L6 9.2l4.4-1.6L12 3Z" />
			<path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14Z" />
		</>,
	);

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

export const ActivityIcon = ({ size = 15 }: Props) =>
	svg(size, <path d="M3 12h4l3 8 4-16 3 8h4" />);

export const PlugIcon = ({ size = 15 }: Props) =>
	svg(
		size,
		<>
			<path d="M9 2v6M15 2v6" />
			<path d="M7 8h10v3a5 5 0 0 1-10 0V8Z" />
			<path d="M12 16v6" />
		</>,
	);

export const PanelRightIcon = ({ size = 15 }: Props) =>
	svg(
		size,
		<>
			<rect x="3" y="4" width="18" height="16" rx="2" />
			<path d="M15 4v16" />
		</>,
	);

export const CloseIcon = ({ size = 14 }: Props) =>
	svg(size, <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>);
