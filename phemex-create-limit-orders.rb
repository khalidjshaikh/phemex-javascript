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
  # Format price as scientific notation e4: 60000 → 6e4, 63000 → 6.3e4, etc.
  base = price / 10000.0
  price_str = if base == base.to_i
                "#{base.to_i}e4"
              else
                # Remove trailing zeros after decimal, e.g. "6.30" -> "6.3"
                formatted = ("%g" % base)
                "#{formatted}e4"
              end


  s = "./phemex-create-limit-order.ts --account coin-m --symbol BTCUSD --side #{side} --price #{price_str} --qty #{qty} --leverage #{leverage}"

  if dry_run
    puts "[DRY-RUN] #{s}"
  else
    puts s
    `#{s}`
  end
end
