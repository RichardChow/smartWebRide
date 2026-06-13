import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LoginView } from './LoginView';

describe('LoginView', () => {
  it('submits email and password', async () => {
    const onLogin = vi.fn().mockResolvedValue(undefined);
    render(<LoginView onLogin={onLogin} />);

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'Chen.Lin@rbbn.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: '进入' }));

    await waitFor(() => {
      expect(onLogin).toHaveBeenCalledWith('Chen.Lin@rbbn.com', '123456');
    });
  });

  it('keeps submit disabled until both fields are present', () => {
    render(<LoginView onLogin={vi.fn()} />);

    const button = screen.getByRole('button', { name: '进入' });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'Chen.Lin@rbbn.com' } });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText('密码'), { target: { value: '123456' } });
    expect(button).not.toBeDisabled();
  });

  it('shows login errors', async () => {
    const onLogin = vi.fn().mockRejectedValue(new Error('invalid email or password'));
    render(<LoginView onLogin={onLogin} />);

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'Chen.Lin@rbbn.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: '进入' }));

    expect(await screen.findByText('invalid email or password')).toBeInTheDocument();
  });
});
