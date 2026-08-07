#!/usr/bin/env ruby
# Watch markLast.txt and indexLast.txt, print both values every second.
# Track the running min/max of the indexLast.txt value within the current
# segment; announce new segment highs/lows on screen + via /usr/bin/say.
# Whenever the index value crosses zero, the min/max are reset to zero and
# a fresh segment begins.
files = [
  "./markLast.txt",
  "./indexLast.txt",
]
last_file = "./last.txt"

running_min = nil
running_max = nil
prev_index  = nil
prev_mark   = nil
# Previous value of last.txt (reset trigger when it changes).
prev_last   = nil
# True once |index| has reached >= 0.10 since the last "point of inflection".
past_threshold = false
# True while a slope change is awaited after a point of inflection.
awaiting_slope = false
# Direction of the last observed move ("positive"/"negative"), used to
# verbalize what the slope changed from.
last_dir = nil

# Speak via /usr/bin/say, printing a visible marker so every speech
# attempt is confirmed on screen.
def speak(text)
  puts "[say] #{text}"
  $stdout.flush
  IO.popen("/usr/bin/say", "w") { |io| io.write(text) }
end

# Format a float for speech without a leading zero (0.15 -> ".15",
# -0.15 -> "-.15"); values >= 1 keep their integer part. Negative
# values get an explicit "minus" prefix because /usr/bin/say does not
# pronounce a leading "-".
def speak_number(n)
  sign = n.negative? ? "minus " : ""
  sign + format("%.2f", n.abs).sub(/\A0\./, '.')
end

loop do
  values = files.map do |f|
    begin
      Float(File.read(f).strip)
    rescue ArgumentError, Errno::ENOENT, Errno::EACCES
      nil
    end
  end

  mark, index = values
  if mark && index
    # Track whether the value has strayed beyond +/- 0.10 since the
    # last "point of inflection".
    past_threshold = true if index.abs >= 0.10

    # Announce "point of inflection" on a transition to exactly zero, but
    # only if |index| passed 0.10 since the previous announcement.
    if index == 0.0 && prev_index != 0.0 && past_threshold
      past_threshold = false
      awaiting_slope = true
      puts "*** POINT OF INFLECTION (zero) ***"
      speak("point of inflection")
    end

    # Announce the slope once per inflection: the direction of the first
    # non-zero reading after leaving zero (the post-zero direction).
    if awaiting_slope && prev_index == 0.0 && index != 0.0
      awaiting_slope = false
      direction = index > 0 ? "positive" : "negative"
      if last_dir && last_dir != direction
        puts "*** SLOPE CHANGED from #{last_dir.upcase} to #{direction.upcase} ***"
        speak("slope changed from #{last_dir} to #{direction}")
      else
        puts "*** SLOPE CHANGED to #{direction.upcase} ***"
        speak("slope changed to #{direction}")
      end
    end

    # Track the direction of the last move (the "from" in slope changes).
    # Updated after the slope check so it holds the pre-change direction.
    last_dir = index > prev_index ? "positive" : "negative" if prev_index && index != prev_index

    # Reset min/max to zero when mark OR index reaches zero: on a
    # transition to exactly zero or a sign change (crossing zero), but
    # not repeatedly while parked at zero.
    mark_zero = prev_mark && ((mark == 0.0 && prev_mark != 0.0) ||
                              (prev_mark > 0 && mark < 0) ||
                              (prev_mark < 0 && mark > 0))
    index_zero = prev_index && ((index == 0.0 && prev_index != 0.0) ||
                                (prev_index > 0 && index < 0) ||
                                (prev_index < 0 && index > 0))
    if mark_zero || index_zero
      running_min = 0.0
      running_max = 0.0
      puts "*** RESET min/max at zero ***"
    end

    # Reset min/max whenever the value in last.txt changes.
    last_val = begin
      Float(File.read(last_file).strip)
    rescue ArgumentError, Errno::ENOENT, Errno::EACCES
      nil
    end
    last_changed = last_val != prev_last
    if last_changed && last_val && prev_last
      running_min = 0.0
      running_max = 0.0
      puts "*** RESET min/max (last.txt changed: #{prev_last} -> #{last_val}) ***"
    end
    prev_last = last_val

    if running_min.nil?
      # first reading: establish the baseline
      running_min = index
      running_max = index
    else
      if index > running_max
        running_max = index
        puts format("*** NEW MAX of index: %.2f ***", index)
        # Speak a new maximum only when the value is above zero.
        speak("new maximum #{speak_number(index)}") if index > 0 && index.abs >= 0.10
      end
      if index < running_min
        running_min = index
        puts format("*** NEW MIN of index: %.2f ***", index)
        # Speak a new minimum only when the value is below zero.
        speak("new minimum #{speak_number(index)}") if index < 0 && index.abs >= 0.10
      end
    end

    last_str = last_val ? format("%6.2f", last_val) : "   n/a"
    puts format("%s  %6.2f %-5s  %6.2f %-5s  %6.2f %-5s  %6.2f %-5s  %6.2f %-5s",
                Time.now.strftime('%H:%M:%S'),
                index, "index", mark, "mark", running_min, "min",
                running_max, "max", last_str, "last")
    $stdout.flush

    prev_index = index
    prev_mark   = mark
  else
    puts "#{Time.now.strftime('%H:%M:%S')}  no readable values"
    $stdout.flush
  end

  sleep 1
end
