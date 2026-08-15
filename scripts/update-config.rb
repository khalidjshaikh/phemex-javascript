#!/usr/bin/env ruby
require 'json'

config_path = File.join(__dir__, '..', 'config', 'config.json')
data_dir = File.join(__dir__, '..', 'data')

config = JSON.parse(File.read(config_path))

config.each do |symbol, settings|
  max_index_file = File.join(data_dir, "#{symbol}-maxIndex.txt")
  min_index_file = File.join(data_dir, "#{symbol}-minIndex.txt")

  unless File.exist?(max_index_file) && File.exist?(min_index_file)
    puts "Skipping #{symbol}: missing index files"
    next
  end

  max_index = File.read(max_index_file).strip.to_f
  min_index = File.read(min_index_file).strip.to_f

  threshold = (max_index - min_index) / 2
  bias = threshold - max_index

  puts "#{symbol}: threshold=#{threshold}, bias=#{bias}"

  settings['threshold'] = threshold.round(9)
  settings['bias'] = bias.round(9)
end

File.write(config_path, JSON.pretty_generate(config))
puts "\nConfig updated successfully."
