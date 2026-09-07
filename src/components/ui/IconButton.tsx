import { Button, type ButtonProps } from './Button'

export function IconButton({ className = '', variant = 'ghost', ...props }: Omit<ButtonProps, 'size'>) {
  return <Button size="icon" variant={variant} className={`rounded-full ${className}`} {...props} />
}
