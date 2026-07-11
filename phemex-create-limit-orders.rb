#!/usr/bin/env ruby

USAGE = <<~USAGE
  Usage: #{$PROGRAM_NAME} [--no-dry-run]

  Generates and submits limit orders to Phemex for BTCUSD perpetual.

  Flags:
    --no-dry-run    Actually execute the shell commands. Without this flag,
                    the script prints the commands it would run (dry-run mode).
USAGE

dry_run = !ARGV.include?("--no-dry-run")

if ARGV.empty?
  puts USAGE
  puts
  puts "No arguments given — running in dry-run mode. Pass --no-dry-run to execute."
  puts
end

# orders = [
#   [:Short, 6.4e4, 1, 100],
#   [:Long, 6.2e4, 1, 100],
#   [:Long, 6.1e4, 1, 100],
#   [:Long, 6e4, 1, 100]
# ]

# XTI/USDT:USDT
# BTC/USD:BTC
orders=[]
# 1.times{|i| p i; orders << [:BTCUSD, :Short, 5.8e4 + i * 1e3, 1, 100]}
# 3.times{|i| p i; orders << [:BTCUSD, :Short, 6.5e4 + i * 1e3, 1, 100]}
# 3.times{|i| p i; orders << [:BTCUSD, :Long, 6.3e4 - i * 1e3, 1, 100]}
# 1.times{|i| p i; orders << [:XTIUSDT, :Long, 71 + i, 0.01, 100]}
# 21.times{|i| p i; orders << [:XTIUSDT, :Long, 50 + i, 0.01, 100]}
# 3.times{|i| orders << [:XTIUSDT, :Long, 70 - i, 0.01, 100]}
4.times{|i| orders << [:XTIUSDT, :Short, 80 + i, 0.01, 100]}

orders.each do |symbol, side, price, qty, leverage|
  s = "./phemex-create-limit-order.ts --account coin-m --symbol #{symbol} --side #{side} --price #{price} --qty #{qty} --leverage #{leverage}" if symbol.to_sym == :BTCUSD
  s = "./phemex-create-limit-order.ts --account usdt-m --symbol #{symbol} --side #{side} --price #{price} --qty #{qty} --leverage #{leverage} --posSide #{side}" if symbol.to_sym == :XTIUSDT

  if dry_run
    puts "[DRY-RUN] #{s}"
  else
    puts s
    `#{s}`
  end
end
