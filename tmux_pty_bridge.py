#!/usr/bin/env python3

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_winsize(fd: int, rows: int, cols: int) -> None:
    try:
        packed = struct.pack('HHHH', rows, cols, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)
    except OSError:
        pass


def main() -> int:
    if len(sys.argv) < 2:
        print('usage: tmux_pty_bridge.py <command> [args...]', file=sys.stderr)
        return 2

    child_argv = sys.argv[1:]
    rows = int(os.environ.get('TMUX_INTEGRATED_PTY_ROWS', '50'))
    cols = int(os.environ.get('TMUX_INTEGRATED_PTY_COLS', '220'))

    pid, master_fd = pty.fork()
    if pid == 0:
        os.execvpe(child_argv[0], child_argv, os.environ)
        raise SystemExit(127)

    set_winsize(master_fd, rows, cols)

    def forward_signal(signum: int, _frame) -> None:
        try:
            os.kill(pid, signum)
        except OSError:
            pass

    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, forward_signal)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    input_open = True

    try:
        while True:
            read_fds = [master_fd]
            if input_open:
                read_fds.append(stdin_fd)

            readable, _, _ = select.select(read_fds, [], [])

            if master_fd in readable:
                try:
                    data = os.read(master_fd, 65536)
                except OSError as err:
                    if err.errno == errno.EIO:
                        break
                    raise

                if not data:
                    break

                os.write(stdout_fd, data)

            if input_open and stdin_fd in readable:
                data = os.read(stdin_fd, 65536)
                if not data:
                    input_open = False
                else:
                    os.write(master_fd, data)
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass

    _, status = os.waitpid(pid, 0)
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())