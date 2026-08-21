#!/usr/bin/env ruby
require 'json5'
require 'optparse'

multiplier = 1.5
input_file = File.join(__dir__, '..', 'config', 'gm.json5')
output_file = File.join(__dir__, '..', 'config', 'a02.json5')

OptionParser.new do |opts|
  opts.banner = "Usage: #{$0} [options]"

  opts.on("-m", "--multiplier VALUE", Float, "Threshold multiplier (default: 1.5)") do |v|
    multiplier = v
  end

  opts.on("-i", "--input FILE", "Input config file") do |v|
    input_file = v
  end

  opts.on("-o", "--output FILE", "Output config file") do |v|
    output_file = v
  end

  opts.on("-h", "--help", "Show this help") do
    puts opts
    exit
  end
end.parse!

config = JSON5.parse(File.read(input_file))

config.each do |symbol, settings|
  next unless settings.key?("threshold")
  settings["threshold"] = (settings["threshold"] * multiplier).round(6)
end

output = "{\n" + config.map { |symbol, settings|
  inner = settings.map { |k, v|
    val = case v
          when true then "true"
          when false then "false"
          when Integer then v.to_s
          when Float
            if v == v.round(0) && v.abs < 1e15
              v.round(0).to_s
            else
              s = "%.6f" % v
              s = s.sub(/\.?0+$/, '') if s.include?('.')
              s
            end
          else "\"#{v}\""
          end
    "#{k}: #{val}"
  }.join(", ")
  "  #{symbol}: {#{inner}}"
}.join(",\n") + "\n}\n"

File.write(output_file, output)
puts "Generated #{output_file} with multiplier #{multiplier}"
