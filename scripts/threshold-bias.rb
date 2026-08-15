#!/usr/bin/env ruby

data_dir = File.join(__dir__, '..', 'data')

symbols = Dir.glob("#{data_dir}/*-maxIndex.txt").map { |f| File.basename(f, '-maxIndex.txt') }.sort

symbols.each do |symbol|
  max_index = File.read("#{data_dir}/#{symbol}-maxIndex.txt").strip.to_f
  min_index = File.read("#{data_dir}/#{symbol}-minIndex.txt").strip.to_f

  threshold = max_index - min_index
  half_threshold = threshold / 2
  bias = half_threshold - max_index

  puts "#{symbol}: threshold/2 = #{half_threshold}, bias = #{bias}"
end
