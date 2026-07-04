#!/usr/bin/env ruby

eval '1+1'

# orders = [
#   [:Short, 6.4e4, 1, 100],
#   [:Long, 6.2e4, 1, 100],
#   [:Long, 6.1e4, 1, 100],
#   [:Long, 6e4, 1, 100]
# ]

orders=[]
3.times{|i| orders << [:Short, 6.4e4 + i * 1e3, 1, 100]}
3.times{|i| orders << [:Long, 6e4 + i * 1e3, 1, 100]}


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
  puts s
  # spawn s
  `#{s}`
end
