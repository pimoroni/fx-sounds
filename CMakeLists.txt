cmake_minimum_required(VERSION 3.16)
project(sirensynth CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_library(sirencore STATIC
  src/patch.cpp
  src/synth.cpp
  src/reverb.cpp
  src/wav.cpp
  src/preview.cpp
)
find_package(ZLIB REQUIRED)
target_link_libraries(sirencore PUBLIC ZLIB::ZLIB)
target_include_directories(sirencore PUBLIC src)
target_compile_options(sirencore PRIVATE -Wall -Wextra)

add_executable(sirensynth src/main.cpp)
target_link_libraries(sirensynth PRIVATE sirencore)

enable_testing()
add_executable(loop_check tests/loop_check.cpp)
target_link_libraries(loop_check PRIVATE sirencore)
file(GLOB PRESET_FILES ${CMAKE_SOURCE_DIR}/presets/*.ini)
add_test(NAME loop_check COMMAND loop_check ${PRESET_FILES})
