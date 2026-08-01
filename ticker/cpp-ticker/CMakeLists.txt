cmake_minimum_required(VERSION 3.20)
project(cpp-ticker LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ------------------------------------------------------------------
# Header-only dependencies (downloaded into deps/ by setup script)
# ------------------------------------------------------------------
set(NLOHMANN_JSON_INCLUDE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/deps")

# ------------------------------------------------------------------
# Find Boost (headers only — Boost.Beast & Boost.Asio are header-only)
# ------------------------------------------------------------------
find_package(Boost REQUIRED)

# ------------------------------------------------------------------
# Executable
# ------------------------------------------------------------------
add_executable(phemex-ticker src/main.cpp)

target_include_directories(phemex-ticker PRIVATE
  ${NLOHMANN_JSON_INCLUDE_DIR}
  ${Boost_INCLUDE_DIRS}
)

# Link OpenSSL (needed for TLS / wss://)
find_package(OpenSSL REQUIRED)
target_link_libraries(phemex-ticker PRIVATE OpenSSL::SSL OpenSSL::Crypto)

# pthread on Unix
find_package(Threads REQUIRED)
target_link_libraries(phemex-ticker PRIVATE Threads::Threads)