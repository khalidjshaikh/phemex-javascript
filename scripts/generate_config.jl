#!/usr/bin/env julia
using JSON

function format_value(v::Bool)
    v ? "true" : "false"
end

function format_value(v::Int)
    string(v)
end

function format_value(v::Float64)
    if v == round(v) && abs(v) < 1e15
        string(round(Int, v))
    else
        s = string(v)
        if occursin("e", s) || occursin("E", s)
            s
        else
            s
        end
    end
end

function format_value(v)
    string(v)
end

function format_inner(obj)
    parts = String[]
    for (k, v) in obj
        if v isa Dict
            push!(parts, "\"$k\": $(format_inner(v))")
        else
            push!(parts, "\"$k\": $(format_value(v))")
        end
    end
    "{" * join(parts, ", ") * "}"
end

function main()
    multiplier = 1.5
    input_file = "config/config.json"
    output_file = "config/config.json5"

    args = ARGS
    i = 1
    while i <= length(args)
        if args[i] == "--multiplier" || args[i] == "-m"
            i += 1
            multiplier = parse(Float64, args[i])
        elseif args[i] == "--input" || args[i] == "-i"
            i += 1
            input_file = args[i]
        elseif args[i] == "--output" || args[i] == "-o"
            i += 1
            output_file = args[i]
        elseif args[i] == "--help" || args[i] == "-h"
            println("Usage: julia generate_config.jl [options]")
            println("  -m, --multiplier <value>  Threshold multiplier (default: 1.5)")
            println("  -i, --input <file>        Input config file (default: config/config.json)")
            println("  -o, --output <file>       Output config file (default: config/config.json5)")
            return
        end
        i += 1
    end

    config = Dict(JSON.parsefile(input_file))

    for (symbol, settings) in config
        if haskey(settings, "threshold")
            settings["threshold"] = round(settings["threshold"] * multiplier, sigdigits=6)
        end
    end

    parts = String[]
    for (symbol, settings) in config
        push!(parts, "  \"$symbol\": $(format_inner(settings))")
    end
    output = "{\n" * join(parts, ",\n") * "\n}\n"

    open(output_file, "w") do f
        write(f, output)
    end

    println("Generated $output_file with multiplier $multiplier")
end

main()
