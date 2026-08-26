import * as React from "react";
import { cn } from "@/lib/utils";

// HeroUI-style table: a muted outer "frame" with the header floating
// directly on it, and the data rows forming their own separate rounded
// white block inset inside that frame — not a single flat bordered grid.
const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement> & { containerClassName?: string }
>(({ className, containerClassName, ...props }, ref) => (
  <div className={cn("relative w-full overflow-x-auto rounded-lg bg-muted p-1.5", containerClassName)}>
    {/* border-collapse defaults to `collapse` under Tailwind's preflight,
        which breaks per-cell border-radius — force `separate` so the first/
        last row's corner cells can round into a clean floating block. */}
    <table ref={ref} className={cn("w-full border-separate border-spacing-0 caption-bottom text-sm", className)} {...props} />
  </div>
));
Table.displayName = "Table";

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <thead ref={ref} className={className} {...props} />,
);
TableHeader.displayName = "TableHeader";

const CORNER_ROUNDING =
  "[&>tr:first-child>:first-child]:rounded-tl-md [&>tr:first-child>:last-child]:rounded-tr-md " +
  "[&>tr:last-child>:first-child]:rounded-bl-md [&>tr:last-child>:last-child]:rounded-br-md";

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tbody
      ref={ref}
      // bg-card lives on each cell, not the <tr> — a table row's own
      // background paints as a full rectangle beneath its cells regardless
      // of any border-radius on them, so putting it on <tr> would fill
      // back in the very corners the cell rounding is supposed to reveal.
      className={cn(
        "[&>tr>*]:bg-card [&>tr:hover>*]:bg-accent/40 [&>tr:not(:last-child)>*]:border-b [&>tr>*]:border-border/60 [&>tr>*]:transition-colors",
        CORNER_ROUNDING,
        className,
      )}
      {...props}
    />
  ),
);
TableBody.displayName = "TableBody";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  // Hover/background live on the cells (see TableBody) — a <tr>'s own
  // background always paints as a full rectangle behind its cells, which
  // would defeat per-cell rounding, so this element intentionally carries
  // no bg/hover classes of its own.
  ({ className, ...props }, ref) => <tr ref={ref} className={className} {...props} />,
);
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th ref={ref} className={cn("h-11 px-4 pb-2 text-left align-middle text-xs font-medium uppercase tracking-wide text-muted-foreground", className)} {...props} />
  ),
);
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td ref={ref} className={cn("p-4 align-middle", className)} {...props} />
  ),
);
TableCell.displayName = "TableCell";

const TableRowHeader = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th ref={ref} scope="row" className={cn("p-4 text-left align-middle font-medium", className)} {...props} />
  ),
);
TableRowHeader.displayName = "TableRowHeader";

const TableCaption = React.forwardRef<HTMLTableCaptionElement, React.HTMLAttributes<HTMLTableCaptionElement>>(
  ({ className, ...props }, ref) => (
    <caption ref={ref} className={cn("mt-4 text-sm text-muted-foreground", className)} {...props} />
  ),
);
TableCaption.displayName = "TableCaption";

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableRowHeader, TableCaption };
