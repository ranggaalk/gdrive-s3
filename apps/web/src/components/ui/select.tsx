import type { ReactNode } from "react";
import { Label, ListBox, Select as HeroSelect } from "@heroui/react";
import { useLocale } from "@/components/locale-provider";
import { cn } from "@/lib/utils";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string> {
  value: T;
  options: Array<SelectOption<T>>;
  onValueChange: (value: T) => void;
  /** Visible label, rendered inside the field so it is associated with the trigger. */
  label?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  /** Accessible name when there is no visible `label`. */
  ariaLabel?: string;
}

/**
 * HeroUI's Select, fed from an options array. Every select in the dashboard is
 * a flat list of strings, so this keeps call sites to one line instead of the
 * full Trigger/Value/Indicator/Popover/ListBox composition each time.
 *
 * An empty-string `value` means "nothing chosen yet" and shows the
 * placeholder -- several forms start that way before their options load.
 */
export function Select<T extends string>({
  value,
  options,
  onValueChange,
  label,
  placeholder,
  disabled = false,
  className,
  triggerClassName,
  ariaLabel,
}: SelectProps<T>) {
  const { t } = useLocale();

  return (
    <HeroSelect
      aria-label={label ? undefined : ariaLabel}
      className={cn("w-full", className)}
      disabledKeys={options.filter((option) => option.disabled).map((option) => option.value)}
      fullWidth
      isDisabled={disabled}
      placeholder={placeholder ?? t.common.selectPlaceholder}
      value={value === "" ? null : value}
      onChange={(key) => {
        if (key !== null && !Array.isArray(key)) onValueChange(String(key) as T);
      }}
    >
      {label ? <Label>{label}</Label> : null}
      <HeroSelect.Trigger className={triggerClassName}>
        <HeroSelect.Value className="truncate" />
        <HeroSelect.Indicator />
      </HeroSelect.Trigger>
      <HeroSelect.Popover>
        <ListBox renderEmptyState={() => <p className="px-2 py-1.5 text-sm text-muted">{t.common.noOptions}</p>}>
          {options.map((option) => (
            <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
              {option.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </HeroSelect.Popover>
    </HeroSelect>
  );
}
