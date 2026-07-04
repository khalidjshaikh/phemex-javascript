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

orders=[]
n=4
n.times{|i| orders << [:Short, 6.4e4 + i * 1e3, 1, 100]}
n.times{|i| orders << [:Long, 6.2e4 - i * 1e3, 1, 100]}


orders.each do |side, price, qty, leverage|
  s = "./phemex-create-limit-order.ts --account coin-m --symbol BTCUSD --side #{side} --price #{price} --qty #{qty} --leverage #{leverage}"

  if dry_run
    puts "[DRY-RUN] #{s}"
  else
    puts s
    `#{s}`
  end
end
