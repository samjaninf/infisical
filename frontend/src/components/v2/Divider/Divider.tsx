import { twMerge } from "tailwind-merge";

interface IProps {
  className?: string;
}

export const Divider = ({ className }: IProps): JSX.Element => {
  return (
    <div className={twMerge("flex items-center px-2 opacity-50", className)}>
      <div aria-hidden="true" className="h-1 w-full grow border-t border-mineshaft-300" />
    </div>
  );
};
